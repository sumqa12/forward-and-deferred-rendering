import { Program } from '../core/gl-utils.js';
import { MESH_VS, FORWARD_FS, DEPTH_ONLY_FS } from './shaders.js';

// 「メッシュを描きながらライティングする」Forward 方式の中核。
// ForwardRenderer の全オブジェクトと、DeferredRenderer の半透明 (ハイブリッド) で共有する。
//
// 1. オブジェクトの境界球と各ライトの影響球で CPU カリング → このオブジェクトに効くライトの一覧
// 2. 1 ドローで扱えるのは maxLights 個まで。超えた分は加算ブレンドの追加パス (= 追加ドローコール)
export class ForwardObjectPass {
  constructor(gl) {
    this.gl = gl;
    this.programs = new Map();
    this.depthProgram = new Program(gl, MESH_VS, DEPTH_ONLY_FS);
    this.lightIndices = new Int32Array(256);
    this.uploadPos = null;
    this.uploadColor = null;
  }

  program(maxLights, heatmap) {
    const key = `${maxLights}:${heatmap}`;
    let p = this.programs.get(key);
    if (!p) {
      const defines = { MAX_LIGHTS: maxLights };
      if (heatmap) defines.HEATMAP = 1;
      p = new Program(this.gl, MESH_VS, FORWARD_FS, defines);
      this.programs.set(key, p);
    }
    return p;
  }

  // Z プリパス: 色を書かずに深度だけ先に確定させる
  drawDepth(frame, objects, stats) {
    const gl = this.gl;
    const p = this.depthProgram;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u.uProjection, false, frame.projection);
    gl.colorMask(false, false, false, false);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    for (const o of objects) {
      gl.uniformMatrix4fv(p.u.uModelView, false, o.modelView);
      gl.bindVertexArray(o.mesh.vao);
      o.mesh.draw(stats);
    }
    gl.colorMask(true, true, true, true);
  }

  cullLights(scene, object) {
    const n = scene.lightCount;
    if (this.lightIndices.length < n) this.lightIndices = new Int32Array(n);
    const lights = scene.lightWorld;
    const [ox, oy, oz] = object.position;
    const or = object.radius;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const b = i * 4;
      const dx = lights[b] - ox, dy = lights[b + 1] - oy, dz = lights[b + 2] - oz;
      const rr = or + lights[b + 3];
      if (dx * dx + dy * dy + dz * dz < rr * rr) this.lightIndices[count++] = i;
    }
    return count;
  }

  // options: { maxLights, heatmap, transparent, depthEqual }
  drawLit(frame, objects, options, stats) {
    const gl = this.gl;
    const { maxLights, heatmap, transparent, depthEqual } = options;
    const p = this.program(maxLights, heatmap);
    const u = p.u;
    const scene = frame.scene;
    if (!this.uploadPos || this.uploadPos.length !== maxLights * 4) {
      this.uploadPos = new Float32Array(maxLights * 4);
      this.uploadColor = new Float32Array(maxLights * 4);
    }
    const pos = this.uploadPos, col = this.uploadColor;

    gl.useProgram(p.program);
    gl.uniformMatrix4fv(u.uProjection, false, frame.projection);
    gl.uniform3fv(u.uAmbient, scene.ambient);
    gl.uniform3fv(u.uDirLightDir, frame.dirLightView);
    gl.uniform3fv(u.uDirLightColor, scene.dirLightColor);

    for (const o of objects) {
      const count = this.cullLights(scene, o);
      stats.lightPairs += count;
      const m = o.material;
      gl.uniformMatrix4fv(u.uModelView, false, o.modelView);
      gl.uniform3fv(u.uAlbedo, m.albedo);
      gl.uniform1f(u.uSpecular, m.specular);
      gl.uniform1f(u.uShininess, m.shininess);
      gl.uniform1f(u.uOpacity, m.opacity);
      gl.bindVertexArray(o.mesh.vao);

      const passes = Math.max(1, Math.ceil(count / maxLights));
      for (let pass = 0; pass < passes; pass++) {
        const start = pass * maxLights;
        const c = Math.min(maxLights, count - start);
        for (let k = 0; k < c; k++) {
          const i = this.lightIndices[start + k];
          pos.set(frame.viewLights.subarray(i * 4, i * 4 + 4), k * 4);
          col.set(scene.lightColor.subarray(i * 4, i * 4 + 4), k * 4);
        }
        gl.uniform4fv(u.uLightPosRadius, pos);
        gl.uniform4fv(u.uLightColor, col);
        gl.uniform1i(u.uLightCount, Math.max(0, c));
        gl.uniform1i(u.uBasePass, pass === 0 ? 1 : 0);
        this.setPassState(pass, heatmap, transparent, depthEqual);
        o.mesh.draw(stats);
        if (pass > 0) stats.extraPasses++;
      }
    }
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
  }

  setPassState(pass, heatmap, transparent, depthEqual) {
    const gl = this.gl;
    if (heatmap) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, pass === 0 ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
    } else if (pass === 0) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    if (transparent) {
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
    } else if (pass === 0 && !depthEqual) {
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
    } else {
      // 追加パス (またはプリパス後) は同じ深度のピクセルだけに加算する
      gl.depthFunc(gl.EQUAL);
      gl.depthMask(false);
    }
  }
}

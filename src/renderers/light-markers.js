import { Program } from '../core/gl-utils.js';
import { MARKER_VS, MARKER_FS } from './shaders.js';

export function createMarkerProgram(gl) {
  return new Program(gl, MARKER_VS, MARKER_FS);
}

// ライトの位置を示す小さな発光球。両方式で同一の描画 (インスタンシング 1 ドロー)。
export function drawLightMarkers(gl, program, frame, stats) {
  const scene = frame.scene;
  if (scene.lightCount === 0) return;
  gl.useProgram(program.program);
  gl.uniformMatrix4fv(program.u.uViewProjection, false, frame.viewProjection);
  gl.uniform1f(program.u.uMarkerSize, 0.07);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(scene.markerVao);
  scene.markerMesh.drawInstanced(scene.lightCount, stats);
}

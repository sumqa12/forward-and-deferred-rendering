// WebGL2 の薄いラッパー: シェーダー、テクスチャ、フレームバッファ

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const numbered = source.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
    gl.deleteShader(shader);
    throw new Error(`シェーダーのコンパイルに失敗しました:\n${log}\n${numbered}`);
  }
  return shader;
}

export class Program {
  constructor(gl, vsSource, fsSource, defines = {}) {
    const header = Object.entries(defines).map(([k, v]) => `#define ${k} ${v}`).join('\n');
    const inject = (src) => src.replace(/^(#version[^\n]*\n)/, `$1${header}\n`);
    const vs = compileShader(gl, gl.VERTEX_SHADER, inject(vsSource));
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, inject(fsSource));
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`プログラムのリンクに失敗しました:\n${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    // 最適化で消えた uniform は undefined のまま (WebGL では null 扱いで無視される)
    this.u = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      this.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
    }
  }
}

function bytesPerPixel(gl, internalFormat) {
  switch (internalFormat) {
    case gl.RGBA8: return 4;
    case gl.RGBA16F: return 8;
    case gl.DEPTH_COMPONENT24: return 4;
    default: throw new Error(`未対応のフォーマット: 0x${internalFormat.toString(16)}`);
  }
}

// レンダーターゲット群をまとめて確保・破棄し、使用メモリ量を記録する
export class RenderTargetSet {
  constructor(gl) {
    this.gl = gl;
    this.textures = [];
    this.renderbuffers = [];
    this.framebuffers = [];
    this.bytes = 0;
  }

  texture(width, height, internalFormat, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter ?? gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter ?? gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.textures.push(tex);
    this.bytes += width * height * bytesPerPixel(gl, internalFormat);
    return tex;
  }

  renderbuffer(width, height, internalFormat, samples = 0) {
    const gl = this.gl;
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    if (samples > 0) {
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internalFormat, width, height);
    } else {
      gl.renderbufferStorage(gl.RENDERBUFFER, internalFormat, width, height);
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.renderbuffers.push(rb);
    this.bytes += width * height * bytesPerPixel(gl, internalFormat) * Math.max(1, samples);
    return rb;
  }

  // attachments は WebGLTexture か WebGLRenderbuffer
  framebuffer(colors, depth) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const attach = (point, target) => {
      if (target instanceof WebGLTexture) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, target, 0);
      } else {
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, point, gl.RENDERBUFFER, target);
      }
    };
    colors.forEach((c, i) => attach(gl.COLOR_ATTACHMENT0 + i, c));
    if (depth) attach(gl.DEPTH_ATTACHMENT, depth);
    gl.drawBuffers(colors.length ? colors.map((_, i) => gl.COLOR_ATTACHMENT0 + i) : [gl.NONE]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`フレームバッファが不完全です: 0x${status.toString(16)}`);
    }
    this.framebuffers.push(fb);
    return fb;
  }

  dispose() {
    const gl = this.gl;
    this.framebuffers.forEach((f) => gl.deleteFramebuffer(f));
    this.textures.forEach((t) => gl.deleteTexture(t));
    this.renderbuffers.forEach((r) => gl.deleteRenderbuffer(r));
    this.framebuffers = [];
    this.textures = [];
    this.renderbuffers = [];
    this.bytes = 0;
  }
}

let emptyVao = null;

// 頂点属性なしの全画面三角形 (gl_VertexID から座標を生成)
export function drawFullscreen(gl, stats) {
  if (!emptyVao) emptyVao = gl.createVertexArray();
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (stats) {
    stats.drawCalls++;
    stats.triangles++;
  }
}

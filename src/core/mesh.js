// 頂点属性ロケーションはシェーダー側の layout(location) と一致させる
export const ATTR_POSITION = 0;
export const ATTR_NORMAL = 1;
export const ATTR_INSTANCE_POS_RADIUS = 2;
export const ATTR_INSTANCE_COLOR = 3;

export class Mesh {
  constructor(gl, geometry) {
    this.gl = gl;
    this.indexCount = geometry.indices.length;
    this.triangleCount = this.indexCount / 3;
    this.radius = geometry.radius;

    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
    this.normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);

    this.vao = this.createVao();
  }

  createVao(instanceBuffer = null) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(ATTR_POSITION);
    gl.vertexAttribPointer(ATTR_POSITION, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.enableVertexAttribArray(ATTR_NORMAL);
    gl.vertexAttribPointer(ATTR_NORMAL, 3, gl.FLOAT, false, 0, 0);
    if (instanceBuffer) {
      // ライト 1 個 = vec4(位置, 半径) + vec4(色, 未使用)
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.enableVertexAttribArray(ATTR_INSTANCE_POS_RADIUS);
      gl.vertexAttribPointer(ATTR_INSTANCE_POS_RADIUS, 4, gl.FLOAT, false, 32, 0);
      gl.vertexAttribDivisor(ATTR_INSTANCE_POS_RADIUS, 1);
      gl.enableVertexAttribArray(ATTR_INSTANCE_COLOR);
      gl.vertexAttribPointer(ATTR_INSTANCE_COLOR, 4, gl.FLOAT, false, 32, 16);
      gl.vertexAttribDivisor(ATTR_INSTANCE_COLOR, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }

  draw(stats) {
    const gl = this.gl;
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    stats.drawCalls++;
    stats.triangles += this.triangleCount;
  }

  drawInstanced(instances, stats) {
    const gl = this.gl;
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, instances);
    stats.drawCalls++;
    stats.triangles += this.triangleCount * instances;
  }
}

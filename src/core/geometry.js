// プリミティブ形状の生成。すべて原点中心・外向き CCW。

function finalize(positions, normals, indices) {
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
    radius,
  };
}

// 半辺長 1 の立方体
export function box() {
  // [法線, u, v] で u × v = 法線 となるよう選ぶ
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const positions = [], normals = [], indices = [];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(n[0] + u[0] * su + v[0] * sv, n[1] + u[1] * su + v[1] * sv, n[2] + u[2] * su + v[2] * sv);
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return finalize(positions, normals, indices);
}

// 半径 1 の UV 球
export function sphere(latSegments = 16, lonSegments = 24) {
  const positions = [], normals = [], indices = [];
  for (let i = 0; i <= latSegments; i++) {
    const theta = (i / latSegments) * Math.PI;
    for (let j = 0; j <= lonSegments; j++) {
      const phi = (j / lonSegments) * Math.PI * 2;
      const x = Math.sin(theta) * Math.cos(phi);
      const y = Math.cos(theta);
      const z = Math.sin(theta) * Math.sin(phi);
      positions.push(x, y, z);
      normals.push(x, y, z);
    }
  }
  for (let i = 0; i < latSegments; i++) {
    for (let j = 0; j < lonSegments; j++) {
      const a = i * (lonSegments + 1) + j;
      const b = a + lonSegments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return finalize(positions, normals, indices);
}

// XY 平面に立ったトーラス (Y 軸回転で回して見せる)
export function torus(major = 0.65, minor = 0.28, majorSegments = 40, minorSegments = 20) {
  const positions = [], normals = [], indices = [];
  for (let i = 0; i <= majorSegments; i++) {
    const u = (i / majorSegments) * Math.PI * 2;
    for (let j = 0; j <= minorSegments; j++) {
      const v = (j / minorSegments) * Math.PI * 2;
      const r = major + minor * Math.cos(v);
      positions.push(r * Math.cos(u), r * Math.sin(u), minor * Math.sin(v));
      normals.push(Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v));
    }
  }
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      const a = i * (minorSegments + 1) + j;
      const b = a + minorSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return finalize(positions, normals, indices);
}

// XZ 平面の 1x1 タイル (上向き)
export function plane() {
  const positions = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  return finalize(positions, normals, [0, 3, 2, 0, 2, 1]);
}

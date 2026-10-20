// GLSL ES 3.00 シェーダー。ライティング式 (LIGHTING) は Forward / Deferred で完全に共通にし、
// 見た目の差がパイプラインの違いだけから生まれるようにしている。

const LIGHTING = /* glsl */ `
vec3 shadeBlinnPhong(vec3 N, vec3 V, vec3 L, vec3 albedo, float specular, float shininess) {
  float NdotL = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), shininess) * specular * (shininess + 8.0) / 25.1327;
  return (albedo + vec3(spec)) * NdotL;
}

// lightPosRadius: ビュー空間の位置 + 影響半径。半径の外では厳密に 0 になる減衰。
vec3 evalPointLight(vec3 P, vec3 N, vec3 V, vec3 albedo, float specular, float shininess,
                    vec4 lightPosRadius, vec3 lightColor) {
  vec3 toLight = lightPosRadius.xyz - P;
  float d2 = dot(toLight, toLight);
  float r2 = lightPosRadius.w * lightPosRadius.w;
  if (d2 >= r2) return vec3(0.0);
  vec3 L = toLight * inversesqrt(max(d2, 1e-8));
  float x = d2 / r2;
  float window = clamp(1.0 - x * x, 0.0, 1.0);
  float attenuation = window * window / (1.0 + d2);
  return shadeBlinnPhong(N, V, L, albedo, specular, shininess) * lightColor * attenuation;
}

vec3 evalAmbient(vec3 N, vec3 V, vec3 albedo, float specular, float shininess,
                 vec3 ambient, vec3 dirLightDir, vec3 dirLightColor) {
  return albedo * ambient + shadeBlinnPhong(N, V, dirLightDir, albedo, specular, shininess) * dirLightColor;
}
`;

// ---------------------------------------------------------------- メッシュ共通
export const MESH_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uModelView;
uniform mat4 uProjection;
out vec3 vViewPos;
out vec3 vViewNormal;
// Z プリパスとライティングパスで深度が完全一致するように (depthFunc EQUAL のため)
invariant gl_Position;
void main() {
  vec4 viewPos = uModelView * vec4(aPosition, 1.0);
  vViewPos = viewPos.xyz;
  vViewNormal = mat3(uModelView) * aNormal; // 一様スケールのみなので正規化で十分
  gl_Position = uProjection * viewPos;
}
`;

export const DEPTH_ONLY_FS = /* glsl */ `#version 300 es
precision mediump float;
void main() {}
`;

// ---------------------------------------------------------------- Forward
// MAX_LIGHTS は 1 ドローで扱えるライト数 (uniform 配列のサイズ)。超えた分は追加パスになる。
export const FORWARD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 vViewPos;
in vec3 vViewNormal;
uniform vec3 uAlbedo;
uniform float uSpecular;
uniform float uShininess;
uniform float uOpacity;
uniform vec3 uAmbient;
uniform vec3 uDirLightDir;
uniform vec3 uDirLightColor;
uniform vec4 uLightPosRadius[MAX_LIGHTS];
uniform vec4 uLightColor[MAX_LIGHTS];
uniform int uLightCount;
uniform bool uBasePass;
out vec4 outColor;
${LIGHTING}
void main() {
#ifdef HEATMAP
  // このフラグメントで評価したライト数を加算合成で積み上げる
  outColor = vec4(float(uLightCount), 0.0, 0.0, 0.0);
#else
  vec3 N = normalize(vViewNormal);
  vec3 V = normalize(-vViewPos);
  vec3 color = vec3(0.0);
  if (uBasePass) {
    color += evalAmbient(N, V, uAlbedo, uSpecular, uShininess, uAmbient, uDirLightDir, uDirLightColor);
  }
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    color += evalPointLight(vViewPos, N, V, uAlbedo, uSpecular, uShininess, uLightPosRadius[i], uLightColor[i].rgb);
  }
  outColor = vec4(color, uOpacity);
#endif
}
`;

// ---------------------------------------------------------------- Deferred
// G-buffer レイアウト:
//   RT0 RGBA8   : アルベド.rgb, スペキュラ強度
//   RT1 RGBA16F : ビュー空間法線.xyz, 光沢度 (0 = 背景)
//   深度 DEPTH_COMPONENT24 : 位置は深度から復元する
export const GBUFFER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vViewPos;
in vec3 vViewNormal;
uniform vec3 uAlbedo;
uniform float uSpecular;
uniform float uShininess;
layout(location = 0) out vec4 gAlbedoSpecular;
layout(location = 1) out vec4 gNormalShininess;
void main() {
  gAlbedoSpecular = vec4(uAlbedo, uSpecular);
  gNormalShininess = vec4(normalize(vViewNormal), uShininess);
}
`;

const GBUFFER_READ = /* glsl */ `
uniform sampler2D uGAlbedo;
uniform sampler2D uGNormal;
uniform sampler2D uGDepth;
uniform mat4 uInvProjection;
uniform vec2 uInvSize;
vec3 reconstructViewPos(float depth) {
  vec2 uv = gl_FragCoord.xy * uInvSize;
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjection * clip;
  return view.xyz / view.w;
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// 環境光 + 平行光源 + 背景を全画面で 1 回
export const DEFERRED_AMBIENT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uAmbient;
uniform vec3 uDirLightDir;
uniform vec3 uDirLightColor;
uniform vec3 uBackground;
out vec4 outColor;
${GBUFFER_READ}
${LIGHTING}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float depth = texelFetch(uGDepth, p, 0).r;
  if (depth >= 1.0) {
    outColor = vec4(uBackground, 1.0);
    return;
  }
  vec4 a = texelFetch(uGAlbedo, p, 0);
  vec4 n = texelFetch(uGNormal, p, 0);
  vec3 P = reconstructViewPos(depth);
  vec3 N = normalize(n.xyz);
  outColor = vec4(evalAmbient(N, normalize(-P), a.rgb, a.a, n.a, uAmbient, uDirLightDir, uDirLightColor), 1.0);
}
`;

// 点光源 1 個 = 球メッシュ 1 インスタンス。球が覆うピクセルだけがライティングされる。
export const LIGHT_VOLUME_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec4 aLightPosRadius;
layout(location = 3) in vec4 aLightColor;
uniform mat4 uView;
uniform mat4 uViewProjection;
flat out vec4 vLight;
flat out vec3 vColor;
void main() {
  // 低ポリ球は内接するので少し大きめにして影響範囲を確実に覆う
  vec3 world = aLightPosRadius.xyz + aPosition * aLightPosRadius.w * 1.08;
  vLight = vec4((uView * vec4(aLightPosRadius.xyz, 1.0)).xyz, aLightPosRadius.w);
  vColor = aLightColor.rgb;
  gl_Position = uViewProjection * vec4(world, 1.0);
}
`;

export const LIGHT_VOLUME_FS = /* glsl */ `#version 300 es
precision highp float;
flat in vec4 vLight;
flat in vec3 vColor;
out vec4 outColor;
${GBUFFER_READ}
${LIGHTING}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float depth = texelFetch(uGDepth, p, 0).r;
  if (depth >= 1.0) discard;
#ifdef HEATMAP
  outColor = vec4(1.0, 0.0, 0.0, 0.0);
#else
  vec4 a = texelFetch(uGAlbedo, p, 0);
  vec4 n = texelFetch(uGNormal, p, 0);
  vec3 P = reconstructViewPos(depth);
  vec3 N = normalize(n.xyz);
  outColor = vec4(evalPointLight(P, N, normalize(-P), a.rgb, a.a, n.a, vLight, vColor), 0.0);
#endif
}
`;

// ---------------------------------------------------------------- ライト位置マーカー (両方式共通)
export const MARKER_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec4 aLightPosRadius;
layout(location = 3) in vec4 aLightColor;
uniform mat4 uViewProjection;
uniform float uMarkerSize;
flat out vec3 vColor;
void main() {
  vColor = aLightColor.rgb;
  gl_Position = uViewProjection * vec4(aLightPosRadius.xyz + aPosition * uMarkerSize, 1.0);
}
`;

export const MARKER_FS = /* glsl */ `#version 300 es
precision mediump float;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor / max(max(vColor.r, vColor.g), max(vColor.b, 1e-3)) * 4.0, 1.0);
}
`;

// ---------------------------------------------------------------- ポストプロセス
// uMode: 0 = トーンマップ, 1 = ヒートマップ, 2 = アルベド, 3 = 法線, 4 = 深度, 5 = スペキュラ
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uAux;
uniform int uMode;
uniform float uExposure;
uniform float uHeatMax;
uniform float uNear;
uniform float uFar;
out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 heat(float t) {
  const vec3 stops[7] = vec3[7](
    vec3(0.02, 0.02, 0.05), vec3(0.10, 0.15, 0.60), vec3(0.00, 0.65, 0.90),
    vec3(0.20, 0.85, 0.25), vec3(1.00, 0.88, 0.10), vec3(1.00, 0.25, 0.10), vec3(1.00, 1.00, 1.00));
  float s = clamp(t, 0.0, 1.0) * 6.0;
  int i = min(int(floor(s)), 5);
  return mix(stops[i], stops[i + 1], s - float(i));
}

void main() {
  vec4 s = texture(uTex, vUv);
  vec3 c;
  if (uMode == 0) {
    c = pow(aces(s.rgb * uExposure), vec3(1.0 / 2.2));
  } else if (uMode == 1) {
    c = heat(s.r / uHeatMax);
  } else if (uMode == 2) {
    c = pow(s.rgb, vec3(1.0 / 2.2));
  } else if (uMode == 3) {
    c = s.a > 0.0 ? s.rgb * 0.5 + 0.5 : vec3(0.0);
  } else if (uMode == 4) {
    float z = s.r * 2.0 - 1.0;
    float linear = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
    c = s.r >= 1.0 ? vec3(0.0) : vec3(1.0 - clamp(linear / 70.0, 0.0, 1.0));
  } else {
    // スペキュラ強度 (RT0.a)。背景判定は法線バッファで行う
    c = texture(uAux, vUv).a > 0.0 ? vec3(s.a) : vec3(0.0);
  }
  outColor = vec4(c, 1.0);
}
`;

// FXAA (Lottes の簡易版)。トーンマップ後の LDR 画像に掛ける。
export const FXAA_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexelSize;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  vec3 rgbNW = texture(uTex, vUv + vec2(-1.0, -1.0) * uTexelSize).rgb;
  vec3 rgbNE = texture(uTex, vUv + vec2( 1.0, -1.0) * uTexelSize).rgb;
  vec3 rgbSW = texture(uTex, vUv + vec2(-1.0,  1.0) * uTexelSize).rgb;
  vec3 rgbSE = texture(uTex, vUv + vec2( 1.0,  1.0) * uTexelSize).rgb;
  vec3 rgbM = texture(uTex, vUv).rgb;
  float lNW = dot(rgbNW, LUMA), lNE = dot(rgbNE, LUMA), lSW = dot(rgbSW, LUMA), lSE = dot(rgbSE, LUMA);
  float lM = dot(rgbM, LUMA);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * (0.25 / 8.0), 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexelSize;
  vec3 rgbA = 0.5 * (texture(uTex, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture(uTex, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(uTex, vUv - dir * 0.5).rgb + texture(uTex, vUv + dir * 0.5).rgb);
  float lB = dot(rgbB, LUMA);
  outColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

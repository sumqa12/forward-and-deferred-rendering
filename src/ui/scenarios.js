// 各メリット・デメリットを体感するためのプリセット
export const SCENARIOS = [
  {
    id: 'few-lights',
    title: 'ライト少数・高解像度',
    tag: 'Forward 有利',
    options: {
      mode: 'split', view: 'lit', lightCount: 6, lightRadius: 8, grid: 10, resolutionScale: 1.5,
      transparent: false, msaa: false, fxaa: false, prepass: false,
    },
    note: 'ライトが少ないと Forward はほぼ 1 パスで終わります。Deferred はライト数に関係なく G-buffer の書き込み・読み出しという固定コストがかかり、「RT メモリ」も大きくなります。解像度を上げるほど差が広がります。',
  },
  {
    id: 'many-lights',
    title: '大量の点光源',
    tag: 'Deferred 有利',
    options: {
      mode: 'split', view: 'heatmap', lightCount: 768, lightRadius: 3.5, grid: 12, resolutionScale: 1,
      heatMax: 48, transparent: false, msaa: false, prepass: false, maxLightsPerPass: 8,
    },
    note: 'ヒートマップは 1 ピクセルあたりのライト計算回数です。Forward はオブジェクト単位でしかライトを絞り込めないため、物体全体で多数のライトを計算し、パス数 (ドローコール) も激増します。Deferred はライトの影響範囲のピクセルだけを計算します。表示を「通常」に戻して FPS も比べてみてください。',
  },
  {
    id: 'transparency',
    title: '半透明オブジェクト',
    tag: 'Forward 有利',
    options: {
      mode: 'split', view: 'lit', lightCount: 64, lightRadius: 5, grid: 10, transparent: true,
      deferredTransparency: 'gbuffer', resolutionScale: 1,
    },
    note: '右側 (Deferred) ではガラスが不透明に描かれています。G-buffer は 1 ピクセルに 1 つの表面しか保持できないためです。「Deferred 設定 › 半透明の扱い」を「ハイブリッド」にすると、半透明だけ Forward で追加描画して正しくなります (= 2 系統のパイプラインが必要)。',
  },
  {
    id: 'msaa',
    title: 'アンチエイリアス',
    tag: 'Forward 有利',
    options: {
      mode: 'split', view: 'lit', lightCount: 48, lightRadius: 5, grid: 14, transparent: false,
      msaa: true, fxaa: false, resolutionScale: 0.5,
    },
    note: '解像度を落としてジャギーを強調しています。左 (Forward) は MSAA で輪郭が滑らかですが、右 (Deferred) はギザギザのままです。WebGL2 ではマルチサンプルの G-buffer をサンプル単位で読めません。「FXAA」を ON にするとポストプロセス AA で近づけられます。',
  },
  {
    id: 'overdraw',
    title: 'オーバードロー',
    tag: 'Deferred 有利',
    options: {
      mode: 'split', view: 'heatmap', lightCount: 256, lightRadius: 4, grid: 18, heatMax: 32,
      prepass: false, transparent: false, resolutionScale: 1,
    },
    note: 'Forward は奥の物体を描いた後に手前の物体で上書きすると、隠れた分のライティングが無駄になります (ヒートマップが明るい箇所)。「Forward 設定 › Z プリパス」を ON にすると軽減できますが、ジオメトリを 2 回描くコストが増えます。Deferred は最終的に見えている面だけをライティングします。',
  },
  {
    id: 'gbuffer',
    title: 'G-buffer の中身',
    tag: 'Deferred の仕組み',
    options: { mode: 'deferred', view: 'normal', lightCount: 128, transparent: true, deferredTransparency: 'hybrid' },
    note: 'Deferred がライティング前に書き出す G-buffer です。「表示」でアルベド / 法線 / 深度 / スペキュラを切り替えられます。マテリアルの種類はこのフォーマットに収まる範囲に制限されます。半透明 (ハイブリッド) は G-buffer に含まれていないことも確認できます。',
  },
];

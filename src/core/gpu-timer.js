// EXT_disjoint_timer_query_webgl2 によるパス単位の GPU 時間計測。
// クエリは入れ子にできないため、パスごとに begin/end を順番に呼ぶ。
// 拡張が無い環境では何もしない (available = false)。

export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.available = !!this.ext;
    this.pending = [];
    this.free = [];
    this.active = null;
    this.results = new Map(); // label -> { ms, updated }
  }

  begin(label) {
    if (!this.available) return;
    const gl = this.gl;
    const query = this.free.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, label };
  }

  end() {
    if (!this.available || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll(now) {
    if (!this.available) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    const stillPending = [];
    for (const entry of this.pending) {
      if (!gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) {
        stillPending.push(entry);
        continue;
      }
      if (!disjoint) {
        const ms = gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1e6;
        const prev = this.results.get(entry.label);
        this.results.set(entry.label, {
          ms: prev && now - prev.updated < 1000 ? prev.ms * 0.85 + ms * 0.15 : ms,
          updated: now,
        });
      }
      this.free.push(entry.query);
    }
    this.pending = stillPending;
  }

  // 直近 1 秒以内に更新された計測値だけ返す
  get(label, now) {
    const r = this.results.get(label);
    return r && now - r.updated < 1000 ? r.ms : null;
  }
}

import * as m4 from '../core/math.js';

// マウス/タッチで操作するオービットカメラ
export class OrbitCamera {
  constructor(element) {
    this.target = [0, 0.5, 0];
    this.yaw = 0.7;
    this.pitch = 0.6;
    this.distance = 32;
    this.fov = (50 * Math.PI) / 180;
    this.near = 0.1;
    this.far = 200;
    this.eye = [0, 0, 0];
    this.view = m4.create();
    this.projection = m4.create();
    this.pointers = new Map();
    this.shouldIgnorePointer = () => false;
    this.attach(element);
  }

  attach(el) {
    el.addEventListener('pointerdown', (e) => {
      if (this.shouldIgnorePointer(e)) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      if (this.pointers.size === 1) {
        this.yaw -= (e.clientX - prev.x) * 0.006;
        this.pitch = Math.min(1.5, Math.max(0.05, this.pitch + (e.clientY - prev.y) * 0.006));
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        prev.x = e.clientX;
        prev.y = e.clientY;
        const after = Math.hypot(a.x - b.x, a.y - b.y);
        if (before > 0 && after > 0) this.zoom(before / after);
        return;
      }
      prev.x = e.clientX;
      prev.y = e.clientY;
    });
    const release = (e) => this.pointers.delete(e.pointerId);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(Math.exp(e.deltaY * 0.001));
    }, { passive: false });
  }

  zoom(factor) {
    this.distance = Math.min(90, Math.max(4, this.distance * factor));
  }

  update(aspect) {
    const cp = Math.cos(this.pitch);
    this.eye[0] = this.target[0] + this.distance * cp * Math.sin(this.yaw);
    this.eye[1] = this.target[1] + this.distance * Math.sin(this.pitch);
    this.eye[2] = this.target[2] + this.distance * cp * Math.cos(this.yaw);
    m4.lookAt(this.view, this.eye, this.target, [0, 1, 0]);
    m4.perspective(this.projection, this.fov, aspect, this.near, this.far);
  }
}

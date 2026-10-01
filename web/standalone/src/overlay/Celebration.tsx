import * as React from "react";

/**
 * "You did it" (tutorial round 2): when a tour step with `celebrate: "rainbow"`
 * shows — ERC came back clean, the board passed DRC — a rainbow burst goes off
 * at the mouse and a trail follows it for a moment.
 *
 * Painted on a pointer-transparent canvas above the editor: KiCad owns the real
 * cursor (wx rewrites `#canvas`'s cursor style on every move), so the effect
 * runs next to it instead of replacing it. With prefers-reduced-motion nothing
 * moves; only the chip shows.
 */

export const CELEBRATION_MS = 2600;

const RAINBOW = "linear-gradient(90deg,#ef4444,#f59e0b,#eab308,#22c55e,#3b82f6,#8b5cf6)";

let pointer: { x: number; y: number } | null = null;

/** Remember where the mouse is, so a celebration starts at it (OverlayHost installs this). */
export function trackPointer(): () => void {
  const on = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
  };
  window.addEventListener("pointermove", on, { capture: true, passive: true });
  window.addEventListener("pointerdown", on, { capture: true, passive: true });
  return () => {
    window.removeEventListener("pointermove", on, true);
    window.removeEventListener("pointerdown", on, true);
  };
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  hue: number;
  r: number;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function Celebration({ onDone }: { onDone(): void }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [reduced] = React.useState(prefersReducedMotion);
  const doneRef = React.useRef(onDone);
  doneRef.current = onDone;

  React.useEffect(() => {
    const t = setTimeout(() => doneRef.current(), CELEBRATION_MS);
    return () => clearTimeout(t);
  }, []);

  React.useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();

    const start = performance.now();
    const parts: Particle[] = [];
    const spawn = (x: number, y: number, n: number, speed: number, now: number, ring: boolean) => {
      for (let i = 0; i < n; i++) {
        const angle = ring ? (i / n) * Math.PI * 2 : Math.random() * Math.PI * 2;
        const v = speed * (0.5 + Math.random() * 0.5);
        parts.push({
          x,
          y,
          vx: Math.cos(angle) * v,
          vy: Math.sin(angle) * v,
          born: now,
          life: 700 + Math.random() * 600,
          // The burst is one full rainbow around the ring; the trail cycles through it over time.
          hue: ring ? (i / n) * 360 : (now - start) * 0.36,
          r: 3 + Math.random() * 3,
        });
      }
    };
    const origin = pointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    spawn(origin.x, origin.y, 56, 0.35, start, true);
    const onMove = (e: PointerEvent) => spawn(e.clientX, e.clientY, 3, 0.06, performance.now(), false);
    window.addEventListener("pointermove", onMove, { capture: true, passive: true });
    window.addEventListener("resize", fit);

    let raf = 0;
    let last = start;
    const frame = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        const age = now - p.born;
        if (age > p.life) {
          parts.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.0004 * dt; // a little gravity
        const fade = 1 - age / p.life;
        ctx.globalAlpha = fade;
        ctx.fillStyle = `hsl(${p.hue % 360} 95% 58%)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.6 + 0.4 * fade), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (now - start < CELEBRATION_MS) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("resize", fit);
    };
  }, [reduced]);

  return (
    <>
      {!reduced && (
        <canvas
          ref={canvasRef}
          data-testid="overlay-celebration-trail"
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[46] h-full w-full"
        />
      )}
      <div
        data-testid="overlay-celebration"
        role="status"
        className="pointer-events-none fixed left-1/2 top-14 z-[46] -translate-x-1/2 rounded-full px-4 py-1.5 text-sm font-semibold text-white shadow-lg"
        style={{ background: RAINBOW }}
      >
        ✓ Well done!
      </div>
    </>
  );
}

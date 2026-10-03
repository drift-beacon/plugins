import { Environment,Lightformer,RoundedBox,Sparkles } from "@react-three/drei";
import { Canvas,type ThreeEvent,useFrame,useThree } from "@react-three/fiber";
import { Bloom,EffectComposer } from "@react-three/postprocessing";
import { useReducedMotion } from "motion/react";
import { useEffect,useMemo,useRef } from "react";
import * as THREE from "three";
import type { Face } from "../model";
import { blobTexture,coreShadowTexture,dotTexture,type FaceArt,faceKey,faceTexture,glowTexture,ringTexture } from "./faceArt";

/*
 * The digital twin of the Aqara cube. Faces are laid out like a die: 1 +Y, 2 +Z, 3 +X,
 * 4 −X, 5 −Z, 6 −Y (opposites add up to 7; 1, 2, 3 share the corner facing the camera). Motion is springs and
 * exponential damping, all frame-rate independent.
 */

export type CubePhase = "idle" | "held" | "activated" | "result";

const FACE_IDS: Face[] = ["1", "2", "3", "4", "5", "6"];
const GEO: Record<Face, { normal: THREE.Vector3; rotation: THREE.Euler; up: THREE.Vector3 }> = Object.fromEntries(
  (
    [
      ["1", [0, 1, 0], [-Math.PI / 2, 0, 0]],
      ["2", [0, 0, 1], [0, 0, 0]],
      ["3", [1, 0, 0], [0, Math.PI / 2, 0]],
      ["4", [-1, 0, 0], [0, -Math.PI / 2, 0]],
      ["5", [0, 0, -1], [0, Math.PI, 0]],
      ["6", [0, -1, 0], [Math.PI / 2, 0, 0]],
    ] as const
  ).map(([id, n, r]) => {
    const rotation = new THREE.Euler(...r);
    return [id, { normal: new THREE.Vector3(...n), rotation, up: new THREE.Vector3(0, 1, 0).applyEuler(rotation) }];
  }),
) as never;

const UP = new THREE.Vector3(0, 1, 0);
const FACE_OFFSET = 0.503;

export interface CubeResult {
  face: Face;
  art: FaceArt;
  color: string;
  /** Frames the rolled face flickers through before it lands (a category's pool). */
  pool?: FaceArt[];
}

/** Screen positions of each face centre, for DOM overlays that follow the cube. Written every frame. */
export interface CubeAnchors {
  faces: Record<Face, { x: number; y: number; facing: number }>;
  center: { x: number; y: number };
  listeners: Set<() => void>;
}

export function createAnchors(): CubeAnchors {
  return {
    faces: Object.fromEntries(FACE_IDS.map((f) => [f, { x: 0, y: 0, facing: 0 }])) as CubeAnchors["faces"],
    center: { x: 0, y: 0 },
    listeners: new Set(),
  };
}

export interface Cube3DProps {
  faces: Record<Face, FaceArt>;
  phase: CubePhase;
  result?: CubeResult | null;
  /** While armed, category faces flicker through these frames. */
  flicker?: Partial<Record<Face, FaceArt[]>>;
  /** Faces to light; the rest dim. */
  highlight?: Face[] | null;
  /** Faces to turn toward the viewer (one face, or a corner of three). */
  focus?: Face[] | null;
  selected?: Face | null;
  onFaceClick?: (face: Face) => void;
  onFaceHover?: (face: Face | null) => void;
  anchors?: CubeAnchors;
  /** Stage accent while idle. */
  accent?: string;
  /** Changing this flips every face in sequence when a preset loads. */
  bootKey?: string | number | null;
  /** Camera distance multiplier; animated. */
  zoom?: number;
  /** Where the cube sits across the canvas, as a fraction of its width from centre (+ is right); animated. */
  shift?: number;
  /** Slowly spin when nobody is touching it. Off where labels follow the faces. */
  turntable?: boolean;
  /** Vertical framing, in cube units: negative sits the cube higher in the frame (room for words below); animated. */
  frameY?: number;
  /** The surface colour behind the cube. The canvas is opaque: a transparent canvas under bloom composites badly. */
  background?: string;
  className?: string;
}

const TARGET = new THREE.Vector3(0, 0.12, 0);
const CAM_DIR = new THREE.Vector3(0.66, 0.5, 0.66).normalize();
const CAM_DIST = 4.7;

export function Cube3D({ className, background = "#18181b", ...props }: Cube3DProps) {
  const reduced = useReducedMotion() ?? false;
  const start = CAM_DIR.clone().multiplyScalar(CAM_DIST * (props.zoom ?? 1)).add(TARGET);
  return (
    <div className={className ?? "h-96 w-full"}>
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
        camera={{ position: start.toArray(), fov: 30 }}
        onCreated={({ camera }) => camera.lookAt(TARGET)}
      >
        <color attach="background" args={[background]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[3, 5, 4]} intensity={1.5} />
        <directionalLight position={[-4, 1.5, 2]} intensity={0.35} />
        <Environment resolution={128} frames={1}>
          <Lightformer form="rect" intensity={2.2} position={[0, 5, -1]} scale={[6, 2, 1]} rotation-x={Math.PI / 2} />
          <Lightformer form="rect" intensity={1.2} position={[-5, 1, 1]} scale={[3, 1.5, 1]} rotation-y={Math.PI / 2} />
          <Lightformer form="ring" intensity={0.8} position={[4, 2, 3]} scale={1.5} />
        </Environment>
        <Rig {...props} reduced={reduced} />
        <EffectComposer multisampling={4}>
          <Bloom luminanceThreshold={1} luminanceSmoothing={0.25} intensity={0.9} mipmapBlur radius={0.55} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

interface FaceState {
  glow: number;
  dim: number;
  pop: number;
  ring: number;
  flip: number;
  flipDelay: number;
  shownKey: string;
  shown: THREE.Texture;
  next: THREE.Texture | null;
  nextKey: string;
}

function Rig({
  faces,
  phase,
  result,
  flicker,
  highlight,
  focus,
  selected,
  onFaceClick,
  onFaceHover,
  anchors,
  accent = "#6366f1",
  bootKey,
  zoom = 1,
  shift = 0,
  turntable = true,
  frameY = 0,
  reduced,
}: Omit<Cube3DProps, "className"> & { reduced: boolean }) {
  const { camera, gl, size } = useThree();
  const body = useRef<THREE.Group>(null!);
  const shaker = useRef<THREE.Group>(null!);
  const planes = useRef<(THREE.Mesh | null)[]>([]);
  const mats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const rings = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const rim = useRef<THREE.PointLight>(null!);
  const floor = useRef<THREE.MeshBasicMaterial>(null!);
  const backdrop = useRef<THREE.Mesh>(null!);
  const backdropMat = useRef<THREE.MeshBasicMaterial>(null!);
  const wave = useRef<THREE.Mesh>(null!);
  const waveMat = useRef<THREE.MeshBasicMaterial>(null!);
  const burst = useRef<THREE.Points>(null!);
  const burstMat = useRef<THREE.PointsMaterial>(null!);
  const sparkles = useRef<THREE.Group>(null!);
  const blob = useRef<THREE.Mesh>(null!);
  const blobMat = useRef<THREE.MeshBasicMaterial>(null!);
  const core = useRef<THREE.Mesh>(null!);
  const coreMat = useRef<THREE.MeshBasicMaterial>(null!);
  const hovered = useRef<Face | null>(null);

  // Floor light, shockwave, burst and sparkles live on layer 1: the camera sees them, the contact-shadow camera
  // (layer 0 only) doesn't, so they never cast a shadow of their own quads onto the floor.
  const floorMesh = useRef<THREE.Mesh>(null!);
  useEffect(() => {
    camera.layers.enable(1);
    for (const o of [floorMesh.current, wave.current, burst.current, sparkles.current, backdrop.current]) o?.traverse((c) => c.layers.set(1));
  }, [camera]);

  const textures = useMemo(() => Object.fromEntries(FACE_IDS.map((f) => [f, faceTexture(faces[f])])) as unknown as Record<Face, THREE.Texture>, [faces]);
  const keys = FACE_IDS.map((f) => faceKey(faces[f]));

  const s = useRef({
    t: 0,
    phase,
    phaseT: 0,
    y: 0,
    vy: 0,
    scale: 1,
    vs: 0,
    q: new THREE.Quaternion(),
    w: new THREE.Vector3(),
    tumble: new THREE.Vector3(0.55, 1, 0.3).normalize(),
    qLand: null as THREE.Quaternion | null,
    qPresent: null as THREE.Quaternion | null,
    impacted: false,
    dragging: false,
    drag: new THREE.Vector2(),
    lastUser: -10,
    camBase: camera.position.clone(),
    camShake: 0,
    zoom,
    shift,
    lookY: TARGET.y,
    waveT: -1,
    burstT: -1,
    burstVel: new Float32Array(36 * 3),
    bootKey,
    rimColor: new THREE.Color(accent),
    faces: FACE_IDS.map(
      (f): FaceState => ({ glow: 0.55, dim: 1, pop: 0, ring: 0, flip: 1, flipDelay: 0, shownKey: faceKey(faces[f]), shown: faceTexture(faces[f]), next: null, nextKey: "" }),
    ),
  });

  // Queue a card-flip for every face whose art changed. A new bootKey (preset loaded) staggers all six.
  useEffect(() => {
    const st = s.current;
    const boot = bootKey !== st.bootKey;
    st.bootKey = bootKey;
    FACE_IDS.forEach((f, i) => {
      const fs = st.faces[i];
      if (fs.shownKey === keys[i] && !boot) return;
      if (fs.nextKey === keys[i] && fs.flip < 1) return;
      if (reduced) {
        fs.shown = textures[f];
        fs.shownKey = keys[i];
        return;
      }
      fs.next = textures[f];
      fs.nextKey = keys[i];
      fs.flip = 0;
      fs.flipDelay = boot ? i * 0.07 : 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join("|"), bootKey]);

  // Drag to turn the cube, trackball style, with inertia on release. Only while idle or showing a result.
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number; id: number } | null = null;
    const st = s.current;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      if (st.phase === "held" || st.phase === "activated") return;
      if (!st.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
        st.dragging = true;
        el.setPointerCapture(down.id);
        el.style.cursor = "grabbing";
      }
      if (st.dragging) {
        st.drag.x += e.movementX;
        st.drag.y += e.movementY;
      }
    };
    const onUp = () => {
      down = null;
      if (st.dragging) {
        st.dragging = false;
        st.lastUser = st.t;
        el.style.cursor = "";
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [gl]);

  const tmp = useMemo(
    () => ({
      v: new THREE.Vector3(),
      v2: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      q2: new THREE.Quaternion(),
      c: new THREE.Color(),
      // Private to uprightAround, so callers can pass tmp.v / tmp.v2 in.
      u1: new THREE.Vector3(),
      u2: new THREE.Vector3(),
      u3: new THREE.Vector3(),
      uq: new THREE.Quaternion(),
    }),
    [],
  );

  /** Rotate q (in place) so that the world direction `dirWorld` points along `target`, by fraction k. */
  const turnToward = (q: THREE.Quaternion, dirWorld: THREE.Vector3, target: THREE.Vector3, k: number) => {
    tmp.q.setFromUnitVectors(dirWorld, target);
    tmp.q2.identity().slerp(tmp.q, k);
    q.premultiply(tmp.q2);
  };

  /** Spin q around the view axis until `refLocal` reads as screen-up, by fraction k. Keeps labels upright. */
  const uprightAround = (q: THREE.Quaternion, refLocal: THREE.Vector3, axis: THREE.Vector3, k: number) => {
    const ref = tmp.u1.copy(refLocal).applyQuaternion(q);
    ref.addScaledVector(axis, -ref.dot(axis));
    const up = tmp.u2.copy(UP).addScaledVector(axis, -UP.dot(axis));
    if (ref.lengthSq() < 1e-6 || up.lengthSq() < 1e-6) return;
    ref.normalize();
    up.normalize();
    let ang = Math.acos(THREE.MathUtils.clamp(ref.dot(up), -1, 1));
    if (tmp.u3.crossVectors(ref, up).dot(axis) < 0) ang = -ang;
    tmp.uq.setFromAxisAngle(axis, ang * k);
    q.premultiply(tmp.uq);
  };

  useFrame((_, delta) => {
    const st = s.current;
    const dt = Math.min(delta, 1 / 30);
    st.t += dt;

    // Phase entry.
    if (phase !== st.phase) {
      const prev = st.phase;
      st.phase = phase;
      st.phaseT = 0;
      if (phase === "result" && result) {
        const n = tmp.v.copy(GEO[result.face].normal).applyQuaternion(st.q).normalize();
        st.qLand = new THREE.Quaternion().setFromUnitVectors(n, UP).multiply(st.q);
        const camDir = tmp.v2.copy(camera.position).normalize();
        const present = new THREE.Vector3().copy(camDir).addScaledVector(UP, 1.2).normalize();
        const qp = new THREE.Quaternion().setFromUnitVectors(UP, present).multiply(st.qLand);
        uprightAround(qp, GEO[result.face].up, present, 1);
        st.qPresent = qp;
        st.impacted = false;
        if (reduced) {
          st.q.copy(qp);
          st.y = 0.08;
          st.vy = 0;
        }
      }
      if (phase === "activated") {
        st.tumble.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
      }
      if (prev === "result") {
        st.qLand = st.qPresent = null;
      }
    } else {
      st.phaseT += dt;
    }

    const camDir = tmp.v.copy(camera.position).normalize();

    // ── Height and scale: springs with per-phase targets.
    let yT = 0;
    let k = 60;
    let c = 14;
    let scaleT = 1;
    if (phase === "idle") {
      yT = reduced ? 0 : 0.035 * Math.sin(st.t * 1.2);
    } else if (phase === "held") {
      yT = 0.32 + (reduced ? 0 : 0.02 * Math.sin(st.t * 2.2));
      k = 110;
      c = 13;
      scaleT = 1.03;
    } else if (phase === "activated") {
      yT = 0.4 + (reduced ? 0 : 0.03 * Math.sin(st.t * 3));
      k = 140;
      c = 14;
      scaleT = 1.05;
    } else if (phase === "result") {
      const dropping = st.phaseT < 0.85;
      yT = dropping ? -0.2 : 0.06;
      k = dropping ? 90 : 70;
      c = dropping ? 2 : 16;
    }
    if (reduced && phase !== "result") {
      st.y = yT;
      st.vy = 0;
    } else {
      st.vy += (-k * (st.y - yT) - c * st.vy) * dt;
      st.y += st.vy * dt;
    }
    // The floor: a dropped cube bounces once or twice, and the first contact is the impact.
    if (phase === "result" && st.phaseT < 0.85 && st.y < 0) {
      st.y = 0;
      if (!st.impacted && result) {
        st.impacted = true;
        if (!reduced) {
          st.waveT = 0;
          st.burstT = 0;
          st.camShake = 0.22;
          const vel = st.burstVel;
          for (let i = 0; i < 36; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 0.6 + Math.random() * 1.1;
            vel[i * 3] = Math.cos(a) * r;
            vel[i * 3 + 1] = 1.6 + Math.random() * 1.4;
            vel[i * 3 + 2] = Math.sin(a) * r;
          }
          const pos = burst.current.geometry.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < 36; i++) pos.setXYZ(i, (Math.random() - 0.5) * 0.5, 0.52, (Math.random() - 0.5) * 0.5);
          pos.needsUpdate = true;
          burstMat.current.color.set(result.color);
          waveMat.current.color.set(result.color);
        }
      }
      st.vy = Math.abs(st.vy) > 0.6 ? -st.vy * 0.3 : 0;
    }
    st.vs += (-220 * (st.scale - scaleT) - 22 * st.vs) * dt;
    st.scale += st.vs * dt;

    // ── Orientation.
    const q = st.q;
    if (st.dragging && (st.drag.x || st.drag.y)) {
      const axis = tmp.v2.set(st.drag.y, st.drag.x, 0);
      const len = axis.length();
      axis.normalize().applyQuaternion(camera.quaternion);
      const ang = len * 0.009;
      tmp.q.setFromAxisAngle(axis, ang);
      q.premultiply(tmp.q);
      st.w.copy(axis).multiplyScalar(ang / dt);
      st.drag.set(0, 0);
      st.lastUser = st.t;
    } else if (st.dragging) {
      st.w.multiplyScalar(Math.exp(-20 * dt));
    } else if (phase === "result" && st.qLand && st.qPresent) {
      const target = st.phaseT < 0.85 ? st.qLand : st.qPresent;
      const since = st.t - st.lastUser;
      if (since > 0.6) q.slerp(target, 1 - Math.exp(-(st.phaseT < 0.85 ? 12 : 5) * dt));
      st.w.multiplyScalar(Math.exp(-4 * dt));
    } else if (phase === "held") {
      const wT = reduced ? tmp.v2.set(0, 0, 0) : tmp.v2.set(0.22 * Math.sin(st.t * 1.7), 0.45, 0.18 * Math.cos(st.t * 1.3));
      st.w.lerp(wT, 1 - Math.exp(-4 * dt));
    } else if (phase === "activated") {
      const wT = reduced ? tmp.v2.set(0, 0, 0) : tmp.v2.copy(st.tumble).multiplyScalar(st.phaseT < 0.35 ? 0.6 : 3.2);
      st.w.lerp(wT, 1 - Math.exp(-3 * dt));
    } else if (focus && focus.length > 0) {
      // Turn the focused face (or corner) toward the viewer, then roll so it reads upright.
      const dir = tmp.v2.set(0, 0, 0);
      for (const f of focus) dir.add(GEO[f].normal);
      dir.applyQuaternion(q).normalize();
      const kk = 1 - Math.exp(-(reduced ? 30 : 7) * dt);
      turnToward(q, dir.clone(), camDir, kk);
      // Roll so the faces' labels read as upright as they can together: the average of their label-up vectors
      // goes to screen-up. (A corner's three labels can't all be upright; this keeps most of them readable.)
      const ref = tmp.u3.set(0, 0, 0);
      for (const f of focus) ref.add(GEO[f].up);
      if (ref.lengthSq() < 1e-6) ref.copy(GEO[focus[0]].up);
      uprightAround(q, ref.clone().normalize(), camDir, kk);
      st.w.multiplyScalar(Math.exp(-8 * dt));
    } else {
      // Idle: inertia from a throw, then a slow turntable once the user lets go.
      st.w.multiplyScalar(Math.exp(-2.2 * dt));
      if (turntable && !reduced && st.t - st.lastUser > 1.2) st.w.lerp(tmp.v2.set(0, 0.22, 0), 1 - Math.exp(-1.2 * dt));
      if (st.t - st.lastUser > 2.5) {
        // Settle the tilt so the turntable reads calmly (keep yaw, drop pitch/roll).
        const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
        tmp.q.setFromEuler(new THREE.Euler(0, e.y, 0, "YXZ"));
        q.slerp(tmp.q, 1 - Math.exp(-(reduced ? 30 : 0.9) * dt));
      }
    }
    if (!st.dragging && st.w.lengthSq() > 1e-8) {
      const ang = st.w.length() * dt;
      tmp.q.setFromAxisAngle(tmp.v2.copy(st.w).normalize(), ang);
      q.premultiply(tmp.q);
    }
    q.normalize();

    body.current.position.y = st.y;
    body.current.quaternion.copy(q);
    body.current.scale.setScalar(st.scale);

    // ── Shadow: tight and dark on the table, wide and faint as the cube rises. The core turns with the cube's yaw.
    const lift = Math.max(0, st.y);
    blob.current.scale.setScalar(1.55 + lift * 1.4);
    blobMat.current.opacity = Math.max(0.08, 0.6 - lift * 0.9);
    const yaw = new THREE.Euler().setFromQuaternion(q, "YXZ").y;
    core.current.rotation.z = yaw;
    core.current.scale.setScalar(1.05 + lift * 0.6);
    coreMat.current.opacity = Math.max(0, 0.85 - lift * 2.6);

    // ── Shake: a violent, decaying jitter for the first moments after arming.
    const env = phase === "activated" && !reduced && st.phaseT < 0.6 ? Math.pow(1 - st.phaseT / 0.6, 1.2) : 0;
    const r = () => Math.random() - 0.5;
    shaker.current.position.set(r() * 0.1 * env, r() * 0.07 * env, r() * 0.1 * env);
    shaker.current.rotation.set(r() * 0.26 * env, r() * 0.26 * env, r() * 0.26 * env);

    // ── Camera: dolly and slide (the cube glides across a shared canvas rather than the canvas resizing).
    const kCam = reduced ? 1 : 1 - Math.exp(-5 * dt);
    st.zoom += (zoom - st.zoom) * kCam;
    st.shift += (shift - st.shift) * kCam;
    // The camera follows a lift partway: the cube stays framed, the shadow and floor still show it rising.
    st.lookY += (TARGET.y + st.y * 0.6 + frameY - st.lookY) * (1 - Math.exp(-6 * dt));
    tmp.v2.set(0, st.lookY, 0);
    st.camBase.copy(CAM_DIR).multiplyScalar(CAM_DIST * st.zoom).add(tmp.v2);
    const persp = camera as THREE.PerspectiveCamera;
    if (Math.abs(st.shift) > 0.0005) persp.setViewOffset(size.width, size.height, -st.shift * size.width, 0, size.width, size.height);
    else if (persp.view?.enabled) persp.clearViewOffset();

    // ── Camera kick on impact.
    if (st.camShake > 0) {
      st.camShake = Math.max(0, st.camShake - dt);
      const m = (st.camShake / 0.22) * 0.03;
      camera.position.set(st.camBase.x + r() * m, st.camBase.y + r() * m, st.camBase.z + r() * m);
    } else {
      camera.position.copy(st.camBase);
    }
    camera.lookAt(0, st.lookY, 0);

    // ── Faces: glow, dimming, hover pop, rims, flips and flicker.
    const flickerFrame = Math.floor(st.t / 0.11);
    const resultFlicker =
      phase === "result" && result?.pool && result.pool.length > 1 && !reduced ? Math.max(0, 1 - st.phaseT / 1.05) : 0;
    const lit = highlight && highlight.length ? new Set(highlight) : null;
    FACE_IDS.forEach((f, i) => {
      const fs = st.faces[i];
      const mat = mats.current[i];
      const plane = planes.current[i];
      if (!mat || !plane) return;
      const isHover = hovered.current === f && (phase === "idle" || phase === "result");
      const isRolled = phase === "result" && result?.face === f;

      let glowT = 0.55;
      let dimT = 1;
      if (phase === "idle") {
        if (lit) {
          glowT = lit.has(f) ? 1.05 : 0.3;
          dimT = lit.has(f) ? 1 : 0.4;
        }
        if (isHover) glowT = Math.max(glowT, 1.0);
      } else if (phase === "held") {
        glowT = 0.75 + (reduced ? 0 : 0.08 * Math.sin(st.t * 3 + i));
      } else if (phase === "activated") {
        glowT = 1.05 + (reduced ? 0 : 0.35 * Math.sin(st.t * 6 + i * 1.3));
      } else if (phase === "result") {
        glowT = isRolled ? 1.55 + (reduced ? 0 : 0.2 * Math.sin(st.t * 2.6)) : 0.22;
        dimT = isRolled ? 1 : 0.32;
      }
      const kf = 1 - Math.exp(-10 * dt);
      fs.glow += (glowT - fs.glow) * kf;
      fs.dim += (dimT - fs.dim) * kf;
      fs.pop += ((isHover || (selected === f && phase === "idle") ? 1 : 0) - fs.pop) * (1 - Math.exp(-14 * dt));
      const ringT = phase === "idle" ? (selected === f ? 0.75 + 0.2 * Math.sin(st.t * 4) : isHover ? 0.35 : 0) : isRolled ? 0.9 : 0;
      fs.ring += (ringT - fs.ring) * kf;

      // Flip: squash to an edge, swap the art, open back up. Ease-in-out: it's a morph on screen.
      let scaleX = 1;
      if (fs.flip < 1 && fs.next) {
        if (fs.flipDelay > 0) fs.flipDelay -= dt;
        else {
          fs.flip = Math.min(1, fs.flip + dt / 0.42);
          const p = fs.flip < 0.5 ? 4 * fs.flip ** 3 : 1 - (-2 * fs.flip + 2) ** 3 / 2;
          scaleX = Math.abs(Math.cos(p * Math.PI));
          if (p >= 0.5 && fs.shownKey !== fs.nextKey) {
            fs.shown = fs.next;
            fs.shownKey = fs.nextKey;
          }
          if (fs.flip >= 1) fs.next = null;
        }
      }

      // Which art is on the face right now.
      let map = fs.shown;
      const pool = flicker?.[f];
      if (phase === "activated" && pool && pool.length > 1 && !reduced) {
        map = faceTexture(pool[(flickerFrame + i) % pool.length]);
      } else if (isRolled && result) {
        if (resultFlicker > 0 && result.pool) {
          // Slot machine: frames slow down as it settles, then the rolled activity locks in.
          const idx = Math.floor(Math.pow(st.phaseT, 0.55) * 22);
          map = faceTexture(result.pool[idx % result.pool.length]);
        } else {
          map = faceTexture(result.art);
        }
      }
      if (mat.map !== map) {
        // Same shader either way (a map is always bound), so swapping textures needs no recompile.
        mat.map = map;
        mat.emissiveMap = map;
      }
      mat.emissiveIntensity = fs.glow;
      mat.color.setScalar(fs.dim);
      plane.scale.set(scaleX * (1 + fs.pop * 0.03), 1 + fs.pop * 0.03, 1);
      plane.position.copy(GEO[f].normal).multiplyScalar(FACE_OFFSET + fs.pop * 0.012);
      const ring = rings.current[i];
      if (ring) {
        ring.opacity = fs.ring;
        ring.color.set(faces[f].color ?? "#ffffff");
      }
    });

    // ── Stage light: rim colour and the floor spotlight follow the phase.
    const rimTarget =
      phase === "held" ? "#f59e0b" : phase === "activated" ? "#22d3ee" : phase === "result" && result ? result.color : accent;
    st.rimColor.lerp(tmp.c.set(rimTarget), 1 - Math.exp(-5 * dt));
    rim.current.color.copy(st.rimColor);
    const rimI = phase === "idle" ? 6 : phase === "held" ? 14 : phase === "activated" ? 22 : 18;
    rim.current.intensity += (rimI - rim.current.intensity) * (1 - Math.exp(-5 * dt));
    floor.current.color.copy(st.rimColor);
    const floorO = phase === "idle" ? 0.14 : phase === "result" ? 0.42 : 0.28;
    floor.current.opacity += (floorO - floor.current.opacity) * (1 - Math.exp(-5 * dt));
    // Room light behind the cube, always facing the camera: the phase colour washing the whole stage.
    backdrop.current.quaternion.copy(camera.quaternion);
    backdrop.current.position.set(0, st.lookY, 0).addScaledVector(CAM_DIR, -3.2);
    backdropMat.current.color.copy(st.rimColor);
    const backO = phase === "idle" ? 0.05 : phase === "result" ? 0.2 : 0.14;
    backdropMat.current.opacity += (backO - backdropMat.current.opacity) * (1 - Math.exp(-4 * dt));

    // ── Sparkles while armed.
    const sp = sparkles.current;
    const spT = phase === "activated" && !reduced ? 1 : 0;
    sp.scale.setScalar(sp.scale.x + (spT - sp.scale.x) * (1 - Math.exp(-6 * dt)) || 0.0001);
    sp.visible = sp.scale.x > 0.02;

    // ── Impact: shockwave ring on the floor, a burst of the activity's colour.
    if (st.waveT >= 0) {
      st.waveT += dt;
      const p = Math.min(1, st.waveT / 0.75);
      const e = 1 - Math.pow(1 - p, 3);
      wave.current.scale.setScalar(1 + e * 2.4);
      waveMat.current.opacity = 0.75 * (1 - p);
      if (p >= 1) st.waveT = -1;
    } else waveMat.current.opacity = 0;
    if (st.burstT >= 0) {
      st.burstT += dt;
      const pos = burst.current.geometry.attributes.position as THREE.BufferAttribute;
      const vel = st.burstVel;
      for (let i = 0; i < 36; i++) {
        vel[i * 3 + 1] -= 5.5 * dt;
        pos.setXYZ(i, pos.getX(i) + vel[i * 3] * dt, pos.getY(i) + vel[i * 3 + 1] * dt, pos.getZ(i) + vel[i * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      burstMat.current.opacity = Math.max(0, 1 - st.burstT / 0.95);
      if (st.burstT > 0.95) st.burstT = -1;
    } else burstMat.current.opacity = 0;

    // ── Anchors for DOM overlays.
    if (anchors) {
      const center = tmp.v2.set(0, st.y, 0).project(camera);
      anchors.center.x = (center.x * 0.5 + 0.5) * size.width;
      anchors.center.y = (-center.y * 0.5 + 0.5) * size.height;
      FACE_IDS.forEach((f) => {
        const n = tmp.v.copy(GEO[f].normal).applyQuaternion(q);
        const p = tmp.v2.copy(n).multiplyScalar(0.5 * st.scale).add(new THREE.Vector3(0, st.y, 0));
        const toCam = new THREE.Vector3().copy(camera.position).sub(p).normalize();
        const a = anchors.faces[f];
        a.facing = n.dot(toCam);
        p.project(camera);
        a.x = (p.x * 0.5 + 0.5) * size.width;
        a.y = (-p.y * 0.5 + 0.5) * size.height;
      });
      for (const l of anchors.listeners) l();
    }
  });

  const interactive = phase === "idle" || phase === "result";
  const handleOver = (f: Face) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!interactive) return;
    hovered.current = f;
    gl.domElement.style.cursor = "pointer";
    onFaceHover?.(f);
  };
  const handleOut = (f: Face) => () => {
    if (hovered.current === f) hovered.current = null;
    if (!s.current.dragging) gl.domElement.style.cursor = "";
    onFaceHover?.(null);
  };
  const handleClick = (f: Face) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 6 || phase !== "idle") return;
    onFaceClick?.(f);
  };

  const burstGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(36 * 3), 3));
    return g;
  }, []);

  return (
    <>
      <group ref={body}>
        <group ref={shaker}>
          <RoundedBox args={[1, 1, 1]} radius={0.085} smoothness={5}>
            <meshPhysicalMaterial color="#141417" roughness={0.34} metalness={0.15} clearcoat={0.8} clearcoatRoughness={0.3} />
          </RoundedBox>
          {FACE_IDS.map((f, i) => (
            <mesh
              key={f}
              ref={(m) => {
                planes.current[i] = m;
              }}
              position={GEO[f].normal.clone().multiplyScalar(FACE_OFFSET)}
              rotation={GEO[f].rotation}
              onPointerOver={handleOver(f)}
              onPointerOut={handleOut(f)}
              onClick={handleClick(f)}
            >
              <FacePlane
                initial={s.current.faces[i].shown}
                matRef={(m) => {
                  mats.current[i] = m;
                }}
              />
            </mesh>
          ))}
          {FACE_IDS.map((f, i) => (
            <mesh key={`ring-${f}`} position={GEO[f].normal.clone().multiplyScalar(FACE_OFFSET + 0.004)} rotation={GEO[f].rotation}>
              <planeGeometry args={[0.93, 0.93]} />
              <meshBasicMaterial
                ref={(m) => {
                  rings.current[i] = m;
                }}
                map={ringTexture()}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          ))}
        </group>
      </group>

      <group ref={sparkles} scale={0.0001}>
        <Sparkles count={46} scale={[2.2, 1.8, 2.2]} position={[0, 0.4, 0]} size={3.2} speed={1.4} opacity={0.9} color="#67e8f9" noise={1.2} />
      </group>

      <pointLight ref={rim} position={[-1.8, 1.6, -2]} distance={9} decay={1.4} intensity={6} color={accent} />
      <mesh ref={backdrop} renderOrder={-1}>
        <planeGeometry args={[9, 9]} />
        <meshBasicMaterial ref={backdropMat} map={glowTexture()} transparent opacity={0.05} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <mesh ref={blob} rotation-x={-Math.PI / 2} position={[0, -0.502, 0]} renderOrder={1}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={blobMat} map={blobTexture()} transparent depthWrite={false} opacity={0.6} />
      </mesh>
      <mesh ref={core} rotation-x={-Math.PI / 2} position={[0, -0.501, 0]} renderOrder={2}>
        <planeGeometry args={[1.3, 1.3]} />
        <meshBasicMaterial ref={coreMat} map={coreShadowTexture()} transparent depthWrite={false} opacity={0.85} />
      </mesh>
      <mesh ref={floorMesh} rotation-x={-Math.PI / 2} position={[0, -0.5, 0]}>
        <planeGeometry args={[3.4, 3.4]} />
        <meshBasicMaterial ref={floor} map={glowTexture()} transparent opacity={0.14} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <mesh ref={wave} rotation-x={-Math.PI / 2} position={[0, -0.495, 0]}>
        <ringGeometry args={[0.62, 0.7, 64]} />
        <meshBasicMaterial ref={waveMat} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <points ref={burst} geometry={burstGeo}>
        <pointsMaterial
          ref={burstMat}
          size={0.07}
          map={dotTexture()}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
    </>
  );
}

/**
 * A face plane. Its world transform comes from the parent group; the plane itself is re-oriented each frame by
 * the rig (position along the normal for the hover pop, scale for the flip).
 */
function FacePlane({ initial, matRef }: { initial: THREE.Texture; matRef: (m: THREE.MeshStandardMaterial | null) => void }) {
  return (
    <>
      <planeGeometry args={[0.9, 0.9]} />
      <meshStandardMaterial
        ref={matRef}
        map={initial}
        emissiveMap={initial}
        emissive="#ffffff"
        emissiveIntensity={0.55}
        transparent
        alphaTest={0.02}
        roughness={0.5}
        metalness={0.05}
        toneMapped={false}
      />
    </>
  );
}

/** Run `fn` every frame the cube publishes anchors. */
export function useAnchors(anchors: CubeAnchors | undefined, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!anchors) return;
    const l = () => ref.current();
    anchors.listeners.add(l);
    return () => {
      anchors.listeners.delete(l);
    };
  }, [anchors]);
}

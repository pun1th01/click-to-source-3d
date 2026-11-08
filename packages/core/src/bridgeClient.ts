import * as THREE from "three";
import {
  BRIDGE_HELLO_EVENT,
  BRIDGE_QUERY_EVENT,
  BRIDGE_REPLY_EVENT,
  type BridgeQuery,
  type ProvenanceAddress,
  type SourceStamp,
} from "@click-to-source-3d/shared";
import { getInstanceRecord } from "./instanceCapture.js";
import { resolveSourceRef } from "./resolver.js";
import { allPropsOf, generatorsOf, recordOf, stampOf as recordedStampOf } from "./trace.js";

/**
 * Browser half of the bridge. Answers questions about the live scene that
 * nothing outside the page can answer for itself.
 *
 * Framework-free on purpose: it needs a scene and a camera and nothing else,
 * so the React binding is a thin wrapper in `@click-to-source-3d/overlay` rather
 * than a dependency here.
 */

type SceneHandle = { scene: THREE.Object3D; camera: THREE.Camera };

let handle: SceneHandle | null = null;

/**
 * Incremented whenever a scene is attached.
 *
 * This is not a staleness check, and cannot be used as one. Two measured
 * limits, both of which look like the opposite of what the name suggests:
 *
 * It does not survive a reload. The counter lives in module scope, so a new
 * document starts it again — measured at 1 both before and after a full
 * page reload, with no mismatch for a caller to notice.
 *
 * It does not move when the world regenerates. R3F keeps the same scene
 * object, so nothing re-attaches. Measured across a seed change: the same
 * held address answered `ready` with generation still 1, describing a
 * different tree — x -84.967 where it had been -8.651.
 *
 * So a held address can silently resolve to a different object. What the
 * counter does distinguish is one remount from another *within* a single
 * document, which is all it should be read as saying.
 */
let generation = 0;

export function setBridgeScene(next: SceneHandle | null): void {
  handle = next;

  if (next) {
    generation++;
  }
}

export function getBridgeGeneration(): number {
  return generation;
}

function stampOf(object: THREE.Object3D): SourceStamp | null {
  const stamp = recordedStampOf(object);

  if (stamp?.file && stamp.function && stamp.line !== undefined) {
    return stamp;
  }

  const manual = object.userData?.sourceRef as
    | { file?: string; function?: string; line?: number }
    | undefined;

  if (manual?.file && manual.function && manual.line !== undefined) {
    return { file: manual.file, function: manual.function, line: manual.line };
  }

  return null;
}

function sameSite(a: SourceStamp, b: SourceStamp): boolean {
  return a.file === b.file && a.function === b.function && a.line === b.line;
}

/**
 * Every stamped object in the scene, in traversal order, with the ordinal
 * that distinguishes objects sharing a call site.
 *
 * Traversal order is deterministic for a given scene graph, which is what
 * makes `ordinal` a usable part of an address rather than a lottery.
 */
function addressed(): Array<{
  object: THREE.Object3D;
  stamp: SourceStamp;
  ordinal: number;
}> {
  if (!handle) {
    return [];
  }

  const seen = new Map<string, number>();
  const out: Array<{
    object: THREE.Object3D;
    stamp: SourceStamp;
    ordinal: number;
  }> = [];

  handle.scene.traverse((object) => {
    const stamp = stampOf(object);

    if (!stamp) {
      return;
    }

    const key = `${stamp.file}:${stamp.function}:${stamp.line}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    out.push({ object, stamp, ordinal });
  });

  return out;
}

function findByAddress(address: ProvenanceAddress) {
  return addressed().find(
    (entry) =>
      sameSite(entry.stamp, address) && entry.ordinal === address.ordinal
  );
}

/** Addresses at the same file, offered when an address fails to resolve. */
function nearbyAddresses(address: ProvenanceAddress): ProvenanceAddress[] {
  return addressed()
    .filter((entry) => entry.stamp.file === address.file)
    .map((entry) => ({ ...entry.stamp, ordinal: entry.ordinal }));
}

function describe(object: THREE.Object3D, ordinal: number) {
  const instanced = object as THREE.InstancedMesh;
  const stamp = stampOf(object);

  return {
    address: stamp
      ? {
          file: stamp.file,
          function: stamp.function,
          line: stamp.line,
          ...(stamp.column !== undefined ? { column: stamp.column } : {}),
          ordinal,
        }
      : null,
    kind: instanced.isInstancedMesh ? "InstancedMesh" : object.type,
    name: object.name || null,
    count: instanced.isInstancedMesh ? instanced.count : null,
  };
}

/** Everything known about one object, for a question about that object. */
function detailsOf(object: THREE.Object3D) {
  const record = recordOf(object);
  return {
    props: allPropsOf(object),
    trace: record?.trace ?? [],
    generators: generatorsOf(object),
  };
}

/**
 * Answers one query against the attached scene.
 *
 * Exported because this is the function the event stream calls, so a test
 * that drives it is exercising the shipped path. A test against a stand-in
 * for the bridge would pass whether or not this logic is right.
 */
export function answerBridgeQuery(query: BridgeQuery): unknown {
  if (!handle) {
    return { status: "no_scene", generation };
  }

  if (query.kind === "list_scene_provenance") {
    return {
      status: "ready",
      generation,
      objects: addressed().map((entry) => describe(entry.object, entry.ordinal)),
    };
  }

  if (query.kind === "resolve_at_point") {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2(query.x, query.y),
      handle.camera as THREE.PerspectiveCamera
    );

    const hits = raycaster.intersectObject(handle.scene, true);

    for (const hit of hits) {
      const resolved = resolveSourceRef(hit.object, hit.instanceId);

      if (!resolved) {
        continue;
      }

      const entry = addressed().find((e) => e.object === resolved.object);

      return {
        status: "ready",
        generation,
        kind: (hit.object as THREE.InstancedMesh).isInstancedMesh ? "InstancedMesh" : hit.object.type,
        address: entry
          ? {
              file: entry.stamp.file,
              function: entry.stamp.function,
              line: entry.stamp.line,
              ...(entry.stamp.column !== undefined ? { column: entry.stamp.column } : {}),
              ordinal: entry.ordinal,
              instanceId: hit.instanceId,
            }
          : null,
        sourceRef: resolved.sourceRef,
        ...detailsOf(resolved.object),
        readonly: resolved.readonly ?? false,
        instanceId: resolved.instanceId ?? null,
        distance: hit.distance,
      };
    }

    return { status: "ready", generation, address: null, sourceRef: null };
  }

  if (query.kind !== "get_instance_provenance") {
    // Asks for something only the injected inspector can do, of a page that
    // answers through a transport of its own, which has no canvas to photograph
    // and no highlight to draw with.
    return {
      status: "unsupported",
      generation,
      reason: `${query.kind} needs the injected inspector, and this page connected some other way.`,
    };
  }

  const entry = findByAddress(query.address);

  if (!entry) {
    // An address of the right shape can still name the wrong thing. Failing
    // with the alternatives is recoverable; returning nothing looks like
    // "that object has no provenance".
    return {
      status: "address_not_found",
      generation,
      nearest: nearbyAddresses(query.address),
    };
  }

  const mesh = entry.object as THREE.InstancedMesh;
  const instanceId = query.address.instanceId;

  if (!mesh.isInstancedMesh || instanceId === undefined) {
    const resolved = resolveSourceRef(entry.object);

    return {
      status: "ready",
      generation,
      sourceRef: resolved?.sourceRef ?? null,
      ...detailsOf(entry.object),
      readonly: resolved?.readonly ?? false,
    };
  }

  // Read live from the instance buffer, so the only slot with nothing to
  // report is one three neither renders nor raycasts: outside [0, count).
  const record = getInstanceRecord(mesh, instanceId);

  if (!record) {
    // `cause` is the machine-readable half. An agent should branch on it
    // rather than parse the prose.
    return {
      status: "instance_not_recorded",
      generation,
      count: mesh.count,
      cause: "instance_out_of_range",
      reason: `instanceId ${instanceId} is outside the mesh's current count of ${mesh.count}.`,
    };
  }

  const resolved = resolveSourceRef(mesh, instanceId);

  return {
    status: "ready",
    generation,
    sourceRef: resolved?.sourceRef ?? null,
    readonly: resolved?.readonly ?? true,
    record,
  };
}

/**
 * Stable for the lifetime of this tab, so the hub can recognise a reloaded page
 * as the same page, and keep what it had pointed at through the reload.
 */
function sessionId(): string {
  const KEY = "__cts_bridge_session";

  try {
    const existing = sessionStorage.getItem(KEY);

    if (existing) {
      return existing;
    }

    const fresh = `p${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    sessionStorage.setItem(KEY, fresh);

    return fresh;
  } catch {
    // Private mode, or storage disabled. A per-connection id still works;
    // it only loses the de-duplication.
    return `p${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Answers one envelope, turning a throw into a reply rather than silence. */
function reply(envelope: { requestId?: string; query?: BridgeQuery } | null) {
  if (!envelope?.requestId || !envelope.query) {
    return null;
  }

  let result: unknown;

  try {
    result = answerBridgeQuery(envelope.query);
  } catch (error) {
    result = {
      status: "error",
      generation,
      message: error instanceof Error ? error.message : "query failed",
    };
  }

  return { requestId: envelope.requestId, result };
}

/** The part of Vite's `import.meta.hot` the bridge needs. */
export type HotChannel = {
  send(event: string, data?: unknown): void;
  on(event: string, listener: (data: never) => void): void;
  off?(event: string, listener: (data: never) => void): void;
};

/**
 * Lets the page answer queries the scene alone cannot: ones that draw on the
 * screen or read the canvas. Returns undefined for a query it leaves to the
 * bridge. An answer that takes a frame to produce can be a promise.
 */
export type BridgeExtension = (query: BridgeQuery) => unknown;

/**
 * Answers queries over Vite's HMR websocket, the transport the injected
 * inspector uses.
 *
 * That socket is already open to every page Vite serves, so this adds no
 * connection of its own. The page says hello again whenever the socket
 * reconnects — after a dev-server restart the server has forgotten it — and
 * the server recognises a repeat hello from the same socket as the same page.
 */
export function connectBridgeOverHot(hot: HotChannel, extend?: BridgeExtension): () => void {
  const hello = () => {
    hot.send(BRIDGE_HELLO_EVENT, {
      session: sessionId(),
      url: typeof location === "undefined" ? "unknown" : location.href,
    });
  };

  const failure = (error: unknown) => ({
    status: "error",
    generation,
    message: error instanceof Error ? error.message : "query failed",
  });

  const onQuery = (envelope: { requestId?: string; query?: BridgeQuery }) => {
    if (extend && envelope?.requestId && envelope.query) {
      let extended: unknown;
      try {
        extended = extend(envelope.query);
      } catch (error) {
        extended = failure(error);
      }

      if (extended !== undefined) {
        const requestId = envelope.requestId;
        void Promise.resolve(extended)
          .catch(failure)
          .then((result) => hot.send(BRIDGE_REPLY_EVENT, { requestId, result }));
        return;
      }
    }

    const answer = reply(envelope);
    if (answer) {
      hot.send(BRIDGE_REPLY_EVENT, answer);
    }
  };

  hot.on(BRIDGE_QUERY_EVENT, onQuery as (data: never) => void);
  hot.on("vite:ws:connect", hello as (data: never) => void);
  hello();

  return () => {
    hot.off?.(BRIDGE_QUERY_EVENT, onQuery as (data: never) => void);
    hot.off?.("vite:ws:connect", hello as (data: never) => void);
  };
}

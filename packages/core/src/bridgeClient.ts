import * as THREE from "three";
import {
  BRIDGE_EVENTS_PATH,
  BRIDGE_REPLY_PATH,
  type BridgeQuery,
  type ProvenanceAddress,
  type SourceStamp,
} from "@click-to-source/shared";
import {
  getInstanceRecord,
  getProbeStats,
  hasInstanceRecords,
} from "./instanceCapture.js";
import { resolveSourceRef } from "./resolver.js";

/**
 * Browser half of the bridge. Answers questions about the live scene that
 * nothing outside the page can answer for itself.
 *
 * Framework-free on purpose: it needs a scene and a camera and nothing else,
 * so the React binding is a thin wrapper in `@click-to-source/overlay` rather
 * than a dependency here.
 */

type SceneHandle = { scene: THREE.Object3D; camera: THREE.Camera };

let handle: SceneHandle | null = null;
let source: EventSource | null = null;

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
  const stamp = object.userData?.__ctsSource as SourceStamp | undefined;

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
    address: stamp ? { ...stamp, ordinal } : null,
    kind: instanced.isInstancedMesh ? "InstancedMesh" : object.type,
    count: instanced.isInstancedMesh ? instanced.count : null,
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
        address: entry
          ? { ...entry.stamp, ordinal: entry.ordinal, instanceId: hit.instanceId }
          : null,
        sourceRef: resolved.sourceRef,
        readonly: resolved.readonly ?? false,
        instanceId: resolved.instanceId ?? null,
        distance: hit.distance,
      };
    }

    return { status: "ready", generation, address: null, sourceRef: null };
  }

  // get_instance_provenance
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
      readonly: resolved?.readonly ?? false,
    };
  }

  // The count-aware sweep lives in getInstanceRecord: a slot past a shrunken
  // count, or one whose recorded count no longer matches, yields nothing
  // rather than the previous generation's transform.
  const record = getInstanceRecord(mesh, instanceId);

  if (!record) {
    // Four different situations produce a null record, and they need
    // opposite responses. Collapsing them into one message is what made this
    // misleading: a consumer who never switched capture on was told their
    // instance count had changed, which is a confident explanation of
    // something that never happened.
    //
    // `cause` is the machine-readable half. An agent should branch on it
    // rather than parse the prose, which is why it is not merely a reworded
    // reason string.
    const { cause, reason } = !getProbeStats().installed
      ? {
          cause: "probe_not_installed",
          reason:
            "the instance capture probe is not installed, so no transform was " +
            "ever recorded for any mesh. Pass captureInstances: true to " +
            "clickToSource(), or import @click-to-source/core/probe as the " +
            "first statement of the entry module.",
        }
      : instanceId >= mesh.count
        ? {
            cause: "instance_out_of_range",
            reason: `instanceId ${instanceId} is past the mesh's current count of ${mesh.count}.`,
          }
        : !hasInstanceRecords(mesh)
          ? {
              cause: "no_records_for_mesh",
              reason:
                "the probe is installed but never saw a write for this mesh, " +
                "so its instances were placed before the probe was live. The " +
                "probe must execute before any scene mounts.",
            }
          : {
              cause: "record_swept",
              reason:
                "this slot's record belongs to a generation that is gone. The " +
                "mesh's instance count changed since the slot was written, and " +
                "a stale transform is worse than none.",
            };

    return {
      status: "instance_not_recorded",
      generation,
      count: mesh.count,
      cause,
      reason,
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
 * Stable for the lifetime of this document, so the hub can recognise two
 * sockets from one page as one page.
 *
 * StrictMode mounts an effect twice in development, and a browser does not
 * always surface the first EventSource's close to the server before the
 * second opens. Keyed by socket, the hub then sees two pages and refuses to
 * answer as ambiguous — which was the observed behaviour before this existed.
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

/** Opens the event channel and answers queries until the page goes away. */
export function connectBridge(): () => void {
  if (typeof EventSource === "undefined") {
    return () => undefined;
  }

  // A second call replaces the first rather than being ignored, so a remount
  // cannot leave a stream nobody is reading.
  source?.close();

  source = new EventSource(
    `${BRIDGE_EVENTS_PATH}?session=${encodeURIComponent(sessionId())}`
  );

  source.onmessage = (event) => {
    let envelope: { requestId: string; query: BridgeQuery };

    try {
      envelope = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!envelope?.requestId) {
      return;
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

    void fetch(BRIDGE_REPLY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: envelope.requestId, result }),
    });
  };

  const opened = source;

  return () => {
    // Close only the stream this call opened. A later connect may already
    // have replaced it, and closing that one would silently disconnect the
    // live bridge.
    opened.close();

    if (source === opened) {
      source = null;
    }
  };
}

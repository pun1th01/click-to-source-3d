import React from "react";
import type {
  GeometryDetails,
  MaterialDetails,
  MeshDetails as MeshDetailsData,
} from "../meshDetails.js";

const LABEL_COLOR = "#a8c7fa";
const MUTED = "#aaa";

function count(value: number): string {
  return value.toLocaleString();
}

function vec(values: [number, number, number]): string {
  return values.map((value) => value.toFixed(1)).join(", ");
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ wordBreak: "break-word" }}>{children}</span>
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "8px" }}>
      <div style={{ color: LABEL_COLOR, marginBottom: "2px" }}>{title}</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "2px 8px",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function GeometryGroup({ geometry }: { geometry: GeometryDetails | null }) {
  if (!geometry) {
    return (
      <Group title="Geometry">
        <Row label="none">—</Row>
      </Group>
    );
  }

  return (
    <Group title="Geometry">
      <Row label="vertices">
        {geometry.vertexCount === null ? "—" : count(geometry.vertexCount)}
      </Row>
      <Row label="triangles">
        {geometry.triangleCount === null ? "—" : count(geometry.triangleCount)}
      </Row>
      <Row label="indexed">{String(geometry.indexed)}</Row>
      <Row label="attributes">
        {geometry.attributes.length === 0 ? "—" : geometry.attributes.join(", ")}
      </Row>
      {geometry.boundingBox === null ? (
        <Row label="bounds">not computed</Row>
      ) : (
        <>
          <Row label="bounds min">{vec(geometry.boundingBox.min)}</Row>
          <Row label="bounds max">{vec(geometry.boundingBox.max)}</Row>
        </>
      )}
      {geometry.boundingSphere === null ? (
        <Row label="sphere">not computed</Row>
      ) : (
        <Row label="sphere">
          r {geometry.boundingSphere.radius.toFixed(1)}
        </Row>
      )}
    </Group>
  );
}

function MaterialGroup({
  material,
  index,
  total,
}: {
  material: MaterialDetails;
  index: number;
  total: number;
}) {
  const title = total === 1 ? "Material" : `Material ${index + 1} of ${total}`;

  return (
    <Group title={title}>
      <Row label="type">{material.type}</Row>
      {material.color !== null && (
        <Row label="color">
          <span
            style={{
              display: "inline-block",
              width: "9px",
              height: "9px",
              backgroundColor: material.color,
              border: "1px solid #666",
              marginRight: "5px",
              verticalAlign: "baseline",
            }}
          />
          {material.color}
        </Row>
      )}
      <Row label="transparent">{String(material.transparent)}</Row>
      <Row label="opacity">{material.opacity}</Row>
      <Row label="depthWrite">{String(material.depthWrite)}</Row>
      <Row label="side">{material.side}</Row>
    </Group>
  );
}

export function MeshDetails({
  details,
  open,
  onToggle,
}: {
  details: MeshDetailsData | null;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  if (!details) {
    return null;
  }

  // instanceId is 0-based, matching what getMatrixAt and friends expect, so
  // the wording says "index" rather than the friendlier but misleading
  // 1-based "instance N".
  const summary =
    details.instance === null
      ? details.kind
      : `${details.kind} · index ${count(details.instance.index)} of ${count(
          details.instance.count
        )}`;

  return (
    <div
      style={{
        marginTop: "12px",
        borderTop: "1px solid #555",
        paddingTop: "8px",
      }}
    >
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        data-testid="mesh-details-toggle"
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: "12px",
          padding: 0,
        }}
      >
        <span style={{ color: MUTED, marginRight: "6px" }}>
          {open ? "▾" : "▸"}
        </span>
        {summary}
      </button>

      {open && (
        <div style={{ fontSize: "12px", lineHeight: "1.4", marginTop: "4px" }}>
          <Group title="Object">
            <Row label="type">{details.object.type}</Row>
            <Row label="uuid">
              <span title={details.object.uuid}>
                {details.object.uuid.split("-")[0]}
              </span>
            </Row>
            <Row label="renderOrder">{details.object.renderOrder}</Row>
            <Row label="frustumCulled">
              {String(details.object.frustumCulled)}
            </Row>
          </Group>

          <GeometryGroup geometry={details.geometry} />

          {details.materials.length === 0 ? (
            <Group title="Material">
              <Row label="none">—</Row>
            </Group>
          ) : (
            details.materials.map((material, index) => (
              <MaterialGroup
                key={index}
                material={material}
                index={index}
                total={details.materials.length}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

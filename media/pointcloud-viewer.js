/**
 * pointcloud-viewer.js — Front-end logic for the 3D Point Cloud Viewer.
 *
 * Uses Three.js + OrbitControls for interactive 3D rendering.
 * Supports colour-by-axis gradient, per-point RGB, adjustable point size,
 * save PLY, and viewport sync.
 *
 * @typedef {import('../src/pointCloud/pointCloudProvider').PointCloudData} PointCloudData
 */

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {PointCloudData} */
  let data = window.__matrixViewer.initData;

  let renderer, scene, camera, controls, points;

  const container = document.getElementById("canvas-container");
  const selColorAxis = document.getElementById("sel-coloraxis");
  const rngPointSize = document.getElementById("rng-pointsize");
  const btnReset = document.getElementById("btn-reset");
  const btnSave = document.getElementById("btn-save");
  const selExport = document.getElementById("sel-export");
  const infoLabel = document.getElementById("info-label");
  const syncMount = document.getElementById("sync-controls");

  // ── View sync ─────────────────────────────────────────────────────────────

  /**
   * Viewport synchronisation controller (media/sync-controls.js).
   * Reports the orbit camera position and look-at target.
   */
  const sync = window.MatrixViewerSync.create({
    vscode,
    kind: "pointcloud",
    mount: window.__matrixViewer.showSyncControls === false ? null : syncMount,
    getState: () => ({
      kind: "pointcloud",
      cameraPosition: camera.position.toArray(),
      cameraTarget: controls.target.toArray(),
    }),
    applyState: (s) => {
      camera.position.fromArray(s.cameraPosition);
      controls.target.fromArray(s.cameraTarget);
      // OrbitControls fires "change" from update(); sync-controls.js suppresses
      // the resulting report so the two panels do not ping-pong.
      controls.update();
    },
  });

  function init() {
    infoLabel.textContent = `${data.pointCount} points`;

    // Three.js setup
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e1e);

    camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.001,
      10000
    );
    camera.position.set(0, 0, 5);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.addEventListener("change", () => sync.report());

    buildPoints(data, "xyz");
    animate();

    selColorAxis.addEventListener("change", () => {
      updateColors(selColorAxis.value);
    });
    rngPointSize.addEventListener("input", () => {
      if (points) {
        points.material.size = parseFloat(rngPointSize.value) * 0.01;
      }
    });
    btnReset.addEventListener("click", resetCamera);
    btnSave.addEventListener("click", exportPointCloud);

    window.addEventListener("resize", onResize);
  }

  /**
   * (Re)build the point geometry.
   *
   * @param {PointCloudData} d
   * @param {string} colorMode
   * @param {boolean} [recentreCamera=true] Pass false to keep the current
   *   camera, e.g. on a synced refresh where the group owns the viewport.
   */
  function buildPoints(d, colorMode, recentreCamera) {
    if (points) { scene.remove(points); }

    const n = d.pointCount;
    const positions = new Float32Array(d.xyzValues);
    const colors = new Float32Array(n * 3);

    fillColors(colors, d, colorMode);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingBox();

    const material = new THREE.PointsMaterial({
      size: 0.02,
      vertexColors: true,
      sizeAttenuation: true,
    });

    points = new THREE.Points(geometry, material);
    scene.add(points);

    if (recentreCamera === false) {
      return;
    }

    // Centre camera on bounding box
    const bbox = geometry.boundingBox;
    const centre = new THREE.Vector3();
    bbox.getCenter(centre);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.position.set(centre.x, centre.y, centre.z + maxDim * 2);
    controls.target.copy(centre);
    controls.update();
  }

  function fillColors(colors, d, mode) {
    const n = d.pointCount;
    const b = d.bounds;

    if (mode === "xyz" && d.rgbValues && d.rgbValues.length === n * 3) {
      for (let i = 0; i < n * 3; i++) {
        colors[i] = d.rgbValues[i];
      }
      return;
    }

    const axisIdx = mode === "x" ? 0 : mode === "y" ? 1 : 2;
    const axisMin = mode === "x" ? b.xMin : mode === "y" ? b.yMin : b.zMin;
    const axisMax = mode === "x" ? b.xMax : mode === "y" ? b.yMax : b.zMax;

    for (let i = 0; i < n; i++) {
      const val = d.xyzValues[i * 3 + axisIdx];
      const t = axisMax > axisMin ? (val - axisMin) / (axisMax - axisMin) : 0.5;
      const [r, g, bl] = jetColormap(t);
      colors[i * 3] = r / 255;
      colors[i * 3 + 1] = g / 255;
      colors[i * 3 + 2] = bl / 255;
    }
  }

  function updateColors(mode) {
    if (!points) { return; }
    const colors = new Float32Array(data.pointCount * 3);
    fillColors(colors, data, mode);
    points.geometry.attributes.color.array.set(colors);
    points.geometry.attributes.color.needsUpdate = true;
  }

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  function resetCamera() {
    buildPoints(data, selColorAxis.value);
  }

  function onResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }

  // ── Point cloud export ─────────────────────────────────────────────────
  //
  // Supports four formats via the <select id="sel-export"> dropdown:
  //   ply-binary  — little-endian binary PLY with float xyz + uchar rgb
  //   ply-ascii   — human-readable PLY
  //   pcd-binary  — PCD v0.7 binary with float xyz + float rgb (packed)
  //   pcd-ascii   — PCD v0.7 ASCII
  //
  // All formats include RGB when data.rgbValues is present.

  function exportPointCloud() {
    const fmt = selExport.value;
    const hasRgb = data.rgbValues && data.rgbValues.length === data.pointCount * 3;
    let blob, ext;

    if (fmt === "ply-binary") {
      blob = new Blob([generatePlyBinary(data, hasRgb)], { type: "application/octet-stream" });
      ext = "ply";
    } else if (fmt === "ply-ascii") {
      blob = new Blob([generatePlyAscii(data, hasRgb)], { type: "text/plain" });
      ext = "ply";
    } else if (fmt === "pcd-binary") {
      blob = new Blob([generatePcdBinary(data, hasRgb)], { type: "application/octet-stream" });
      ext = "pcd";
    } else {
      blob = new Blob([generatePcdAscii(data, hasRgb)], { type: "text/plain" });
      ext = "pcd";
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.varName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── PLY encoders ───────────────────────────────────────────────────────

  function generatePlyAscii(d, hasRgb) {
    const lines = ["ply", "format ascii 1.0", `element vertex ${d.pointCount}`];
    lines.push("property float x", "property float y", "property float z");
    if (hasRgb) {
      lines.push("property uchar red", "property uchar green", "property uchar blue");
    }
    lines.push("end_header");

    for (let i = 0; i < d.pointCount; i++) {
      let row = `${d.xyzValues[i * 3].toFixed(6)} ${d.xyzValues[i * 3 + 1].toFixed(6)} ${d.xyzValues[i * 3 + 2].toFixed(6)}`;
      if (hasRgb) {
        row += ` ${Math.round(d.rgbValues[i * 3] * 255)} ${Math.round(d.rgbValues[i * 3 + 1] * 255)} ${Math.round(d.rgbValues[i * 3 + 2] * 255)}`;
      }
      lines.push(row);
    }
    return lines.join("\n");
  }

  function generatePlyBinary(d, hasRgb) {
    // Build ASCII header, then append little-endian binary body.
    const headerLines = ["ply", "format binary_little_endian 1.0", `element vertex ${d.pointCount}`];
    headerLines.push("property float x", "property float y", "property float z");
    if (hasRgb) {
      headerLines.push("property uchar red", "property uchar green", "property uchar blue");
    }
    headerLines.push("end_header");
    const header = headerLines.join("\n") + "\n";

    const stride = hasRgb ? 15 : 12; // 3 floats (12) + 3 bytes (3)
    const body = new Uint8Array(d.pointCount * stride);
    const dv = new DataView(body.buffer);

    for (let i = 0; i < d.pointCount; i++) {
      const off = i * stride;
      dv.setFloat32(off,      d.xyzValues[i * 3],     true);
      dv.setFloat32(off + 4,  d.xyzValues[i * 3 + 1], true);
      dv.setFloat32(off + 8,  d.xyzValues[i * 3 + 2], true);
      if (hasRgb) {
        body[off + 12] = Math.round(d.rgbValues[i * 3] * 255);
        body[off + 13] = Math.round(d.rgbValues[i * 3 + 1] * 255);
        body[off + 14] = Math.round(d.rgbValues[i * 3 + 2] * 255);
      }
    }

    // Concatenate header + body into a single Uint8Array.
    const headerBytes = new TextEncoder().encode(header);
    const result = new Uint8Array(headerBytes.length + body.length);
    result.set(headerBytes, 0);
    result.set(body, headerBytes.length);
    return result;
  }

  // ── PCD encoders ───────────────────────────────────────────────────────
  //
  // PCD stores RGB as a single packed float32 whose bits encode
  // (blue<<16 | green<<8 | red).  This is the PCL convention so the file
  // round-trips correctly in pcl::PointCloud<PointXYZRGB>.

  function _packRgbFloat(r, g, b) {
    // r, g, b are 0–1 floats; convert to 0–255 then pack into a uint32
    // viewed as a little-endian float32.
    const ri = Math.round(r * 255);
    const gi = Math.round(g * 255);
    const bi = Math.round(b * 255);
    const packed = (bi << 16) | (gi << 8) | ri;
    // Reinterpret the uint32 bits as a float32 via DataView.
    const tmp = new ArrayBuffer(4);
    new DataView(tmp).setUint32(0, packed >>> 0, true);
    return new DataView(tmp).getFloat32(0, true);
  }

  function generatePcdAscii(d, hasRgb) {
    const fields = hasRgb ? "x y z rgb" : "x y z";
    const size = hasRgb ? "4 4 4" : "4 4 4";
    const type = hasRgb ? "F F F" : "F F F";
    const count = hasRgb ? "1 1 1" : "1 1 1";

    const header = [
      "# .PCD v0.7 - Point Cloud Data file format",
      "VERSION 0.7",
      `FIELDS ${fields}`,
      `SIZE ${size}`,
      `TYPE ${type}`,
      `COUNT ${count}`,
      `WIDTH ${d.pointCount}`,
      "HEIGHT 1",
      "VIEWPOINT 0 0 0 1 0 0 0",
      `POINTS ${d.pointCount}`,
      "DATA ascii",
    ].join("\n") + "\n";

    const lines = [header];
    for (let i = 0; i < d.pointCount; i++) {
      const x = d.xyzValues[i * 3].toFixed(6);
      const y = d.xyzValues[i * 3 + 1].toFixed(6);
      const z = d.xyzValues[i * 3 + 2].toFixed(6);
      if (hasRgb) {
        const rgb = _packRgbFloat(
          d.rgbValues[i * 3],
          d.rgbValues[i * 3 + 1],
          d.rgbValues[i * 3 + 2]
        );
        lines.push(`${x} ${y} ${z} ${rgb}`);
      } else {
        lines.push(`${x} ${y} ${z}`);
      }
    }
    return lines.join("\n");
  }

  function generatePcdBinary(d, hasRgb) {
    const fields = hasRgb ? "x y z rgb" : "x y z";
    const size = hasRgb ? "4 4 4" : "4 4 4";
    const type = hasRgb ? "F F F" : "F F F";
    const count = hasRgb ? "1 1 1" : "1 1 1";

    const header = [
      "# .PCD v0.7 - Point Cloud Data file format",
      "VERSION 0.7",
      `FIELDS ${fields}`,
      `SIZE ${size}`,
      `TYPE ${type}`,
      `COUNT ${count}`,
      `WIDTH ${d.pointCount}`,
      "HEIGHT 1",
      "VIEWPOINT 0 0 0 1 0 0 0",
      `POINTS ${d.pointCount}`,
      "DATA binary",
    ].join("\n") + "\n";

    const stride = hasRgb ? 16 : 12; // 3 floats + 1 packed rgb float
    const body = new Uint8Array(d.pointCount * stride);
    const dv = new DataView(body.buffer);

    for (let i = 0; i < d.pointCount; i++) {
      const off = i * stride;
      dv.setFloat32(off,      d.xyzValues[i * 3],     true);
      dv.setFloat32(off + 4,  d.xyzValues[i * 3 + 1], true);
      dv.setFloat32(off + 8,  d.xyzValues[i * 3 + 2], true);
      if (hasRgb) {
        const rgb = _packRgbFloat(
          d.rgbValues[i * 3],
          d.rgbValues[i * 3 + 1],
          d.rgbValues[i * 3 + 2]
        );
        dv.setFloat32(off + 12, rgb, true);
      }
    }

    const headerBytes = new TextEncoder().encode(header);
    const result = new Uint8Array(headerBytes.length + body.length);
    result.set(headerBytes, 0);
    result.set(body, headerBytes.length);
    return result;
  }

  // Sync messages ("sync/*") are handled inside sync-controls.js.
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "update" && msg.data) {
      data = msg.data;
      infoLabel.textContent = `${data.pointCount} points`;
      // While synced, a refresh must not recentre the camera — the group owns
      // the viewport.
      buildPoints(data, selColorAxis.value, !sync.isSynced());
    }
  });

  // Simple jet colormap helper
  function jetColormap(t) {
    const r = Math.min(255, Math.max(0, Math.round(255 * (1.5 - Math.abs(t * 4 - 3)))));
    const g = Math.min(255, Math.max(0, Math.round(255 * (1.5 - Math.abs(t * 4 - 2)))));
    const b = Math.min(255, Math.max(0, Math.round(255 * (1.5 - Math.abs(t * 4 - 1)))));
    return [r, g, b];
  }

  init();
})();

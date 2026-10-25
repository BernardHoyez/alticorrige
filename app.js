/**
 * AltiCorrige – Correction d'altitudes GPX/KML/KMZ via IGN Géoplateforme
 */

const IGN_ELEVATION_URL = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";
const DEFAULT_RESOURCE = "ign_rge_alti_wld";
const INVALID_Z = -99999;
const MIN_DELTA_DENIV = 0.5; // m – ignore micro-variations for denivelé

// ─── State ───────────────────────────────────────────────────────────────
let track = null; // { name, points: [{lat, lon, ele?, time?}], originalName, format }
let correctedPoints = null;
let chartInstance = null;

// ─── DOM ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const dropzone = $("#dropzone");
const fileInput = $("#file-input");
const fileNameEl = $("#file-name");
const optionsSection = $("#options-section");
const resultsSection = $("#results-section");
const btnCorrect = $("#btn-correct");
const progressWrap = $("#progress-wrap");
const progressFill = $("#progress-fill");
const progressText = $("#progress-text");
const toastEl = $("#toast");

// ─── Utils ───────────────────────────────────────────────────────────────
function showToast(msg, type = "") {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (type ? ` ${type}` : "");
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, 4200);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function computeDistances(points) {
  const dist = [0];
  let cum = 0;
  for (let i = 1; i < points.length; i++) {
    cum += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    dist.push(cum);
  }
  return dist;
}

function computeDenivelés(elevations) {
  let dPlus = 0;
  let dMinus = 0;
  for (let i = 1; i < elevations.length; i++) {
    const z0 = elevations[i - 1];
    const z1 = elevations[i];
    if (z0 == null || z1 == null || z0 <= INVALID_Z + 1 || z1 <= INVALID_Z + 1) continue;
    const d = z1 - z0;
    if (Math.abs(d) < MIN_DELTA_DENIV) continue;
    if (d > 0) dPlus += d;
    else dMinus += -d;
  }
  return { dPlus, dMinus };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function baseName(filename) {
  return filename.replace(/\.(gpx|kml|kmz)$/i, "");
}

// ─── Parsing ─────────────────────────────────────────────────────────────
function parseGPX(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("GPX invalide");

  const name =
    doc.querySelector("trk > name")?.textContent?.trim() ||
    doc.querySelector("metadata > name")?.textContent?.trim() ||
    "tracé";

  const points = [];
  // Prefer track points, fallback to route points
  let nodes = doc.querySelectorAll("trkpt");
  if (!nodes.length) nodes = doc.querySelectorAll("rtept");
  if (!nodes.length) nodes = doc.querySelectorAll("wpt");

  nodes.forEach((n) => {
    const lat = parseFloat(n.getAttribute("lat"));
    const lon = parseFloat(n.getAttribute("lon"));
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    const eleEl = n.querySelector("ele");
    const timeEl = n.querySelector("time");
    points.push({
      lat,
      lon,
      ele: eleEl ? parseFloat(eleEl.textContent) : null,
      time: timeEl ? timeEl.textContent.trim() : null,
    });
  });

  if (!points.length) throw new Error("Aucun point trouvé dans le GPX");
  return { name, points, format: "gpx" };
}

function parseKML(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("KML invalide");

  const name =
    doc.querySelector("Document > name")?.textContent?.trim() ||
    doc.querySelector("Placemark > name")?.textContent?.trim() ||
    "tracé";

  const points = [];

  // gx:Track (Google Earth extensions)
  const gxCoords = doc.getElementsByTagNameNS("http://www.google.com/kml/ext/2.2", "coord");
  if (gxCoords.length) {
    for (const c of gxCoords) {
      const parts = c.textContent.trim().split(/\s+/);
      if (parts.length >= 2) {
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        const ele = parts.length >= 3 ? parseFloat(parts[2]) : null;
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          points.push({ lat, lon, ele: Number.isNaN(ele) ? null : ele, time: null });
        }
      }
    }
  }

  // Classic LineString / MultiGeometry coordinates
  if (!points.length) {
    const coordNodes = doc.querySelectorAll("LineString > coordinates, coordinates");
    for (const node of coordNodes) {
      const raw = node.textContent.trim();
      if (!raw) continue;
      const tuples = raw.split(/\s+/);
      for (const t of tuples) {
        const parts = t.split(",");
        if (parts.length >= 2) {
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          const ele = parts.length >= 3 ? parseFloat(parts[2]) : null;
          if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
            points.push({ lat, lon, ele: Number.isNaN(ele) ? null : ele, time: null });
          }
        }
      }
    }
  }

  if (!points.length) throw new Error("Aucun point trouvé dans le KML");
  return { name, points, format: "kml" };
}

async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".kmz")) {
    if (typeof JSZip === "undefined") throw new Error("JSZip non chargé");
    const zip = await JSZip.loadAsync(file);
    let kmlEntry = null;
    zip.forEach((path, entry) => {
      if (!kmlEntry && path.toLowerCase().endsWith(".kml") && !entry.dir) {
        kmlEntry = entry;
      }
    });
    if (!kmlEntry) throw new Error("Aucun fichier KML dans le KMZ");
    const text = await kmlEntry.async("text");
    const parsed = parseKML(text);
    parsed.originalName = file.name;
    return parsed;
  }

  const text = await file.text();
  let parsed;
  if (name.endsWith(".gpx")) {
    parsed = parseGPX(text);
  } else if (name.endsWith(".kml")) {
    parsed = parseKML(text);
  } else {
    // Try GPX then KML
    try {
      parsed = parseGPX(text);
    } catch {
      parsed = parseKML(text);
    }
  }
  parsed.originalName = file.name;
  return parsed;
}

// ─── IGN Elevation ───────────────────────────────────────────────────────
async function fetchElevationsBatch(lons, lats, resource) {
  const body = {
    lon: lons.join("|"),
    lat: lats.join("|"),
    resource: resource || DEFAULT_RESOURCE,
    delimiter: "|",
    indent: "false",
    measures: "false",
    zonly: "false",
  };

  const res = await fetch(IGN_ELEVATION_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`IGN HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }

  const data = await res.json();
  if (!data.elevations || !Array.isArray(data.elevations)) {
    throw new Error("Réponse IGN inattendue");
  }
  return data.elevations.map((e) => {
    const z = typeof e === "number" ? e : e.z;
    return z != null && z > INVALID_Z + 1 ? z : null;
  });
}

async function correctAllPoints(points, resource, batchSize, onProgress) {
  const n = points.length;
  const results = new Array(n).fill(null);
  let done = 0;

  for (let start = 0; start < n; start += batchSize) {
    const end = Math.min(start + batchSize, n);
    const slice = points.slice(start, end);
    const lons = slice.map((p) => p.lon);
    const lats = slice.map((p) => p.lat);

    let elevations;
    let attempts = 0;
    while (attempts < 3) {
      try {
        elevations = await fetchElevationsBatch(lons, lats, resource);
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 3) throw err;
        await new Promise((r) => setTimeout(r, 800 * attempts));
      }
    }

    for (let i = 0; i < elevations.length; i++) {
      results[start + i] = elevations[i];
    }
    done = end;
    onProgress?.(done, n);

    // Respect ~5 req/s limit
    if (end < n) await new Promise((r) => setTimeout(r, 220));
  }

  return results;
}

// ─── Export ──────────────────────────────────────────────────────────────
function buildGPX(trackName, points) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AltiCorrige" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(trackName)}</name>
    <desc>Altitudes corrigées via IGN RGE ALTI (AltiCorrige)</desc>
  </metadata>
  <trk>
    <name>${esc(trackName)}</name>
    <trkseg>
`;
  for (const p of points) {
    xml += `      <trkpt lat="${p.lat}" lon="${p.lon}">\n`;
    if (p.ele != null && !Number.isNaN(p.ele)) {
      xml += `        <ele>${p.ele.toFixed(2)}</ele>\n`;
    }
    if (p.time) xml += `        <time>${esc(p.time)}</time>\n`;
    xml += `      </trkpt>\n`;
  }
  xml += `    </trkseg>
  </trk>
</gpx>`;
  return xml;
}

function buildKML(trackName, points) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const coords = points
    .map((p) => {
      const z = p.ele != null && !Number.isNaN(p.ele) ? p.ele.toFixed(2) : "0";
      return `${p.lon},${p.lat},${z}`;
    })
    .join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(trackName)}</name>
    <description>Altitudes corrigées via IGN RGE ALTI (AltiCorrige)</description>
    <Placemark>
      <name>${esc(trackName)}</name>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

// ─── Chart ───────────────────────────────────────────────────────────────
function renderProfile(points) {
  const canvas = $("#profile-chart");
  const distances = computeDistances(points);
  const elevations = points.map((p) => (p.ele != null ? p.ele : null));

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  chartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels: distances.map((d) => (d / 1000).toFixed(2)),
      datasets: [
        {
          label: "Altitude (m)",
          data: elevations,
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14, 165, 233, 0.15)",
          fill: true,
          tension: 0.15,
          pointRadius: points.length > 400 ? 0 : 2,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0]?.dataIndex;
              return i != null ? `Distance : ${(distances[i] / 1000).toFixed(2)} km` : "";
            },
            label: (ctx) =>
              ctx.parsed.y != null ? `Altitude : ${ctx.parsed.y.toFixed(1)} m` : "N/A",
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Distance (km)", color: "#94a3b8" },
          ticks: { color: "#94a3b8", maxTicksLimit: 10 },
          grid: { color: "rgba(148, 163, 184, 0.15)" },
        },
        y: {
          title: { display: true, text: "Altitude (m)", color: "#94a3b8" },
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(148, 163, 184, 0.15)" },
        },
      },
    },
  });
}

function updateStats(points) {
  const elevs = points.map((p) => p.ele).filter((z) => z != null && z > INVALID_Z + 1);
  const { dPlus, dMinus } = computeDenivelés(points.map((p) => p.ele));

  $("#stat-points").textContent = points.length.toLocaleString("fr-FR");
  $("#stat-dplus").textContent = `+${Math.round(dPlus)} m`;
  $("#stat-dminus").textContent = `−${Math.round(dMinus)} m`;

  if (elevs.length) {
    const min = Math.min(...elevs);
    const max = Math.max(...elevs);
    $("#stat-minmax").textContent = `${Math.round(min)} / ${Math.round(max)} m`;
  } else {
    $("#stat-minmax").textContent = "—";
  }
}

// ─── UI handlers ─────────────────────────────────────────────────────────
function resetResults() {
  resultsSection.hidden = true;
  correctedPoints = null;
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

async function handleFile(file) {
  if (!file) return;
  try {
    showToast("Lecture du fichier…");
    track = await parseFile(file);
    fileNameEl.textContent = `${file.name} — ${track.points.length} points`;
    fileNameEl.hidden = false;
    optionsSection.hidden = false;
    btnCorrect.disabled = false;
    resetResults();
    showToast(`Fichier chargé : ${track.points.length} points`, "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Erreur de lecture", "error");
    track = null;
    btnCorrect.disabled = true;
    fileNameEl.hidden = true;
    optionsSection.hidden = true;
    resetResults();
  }
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

["dragenter", "dragover"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

btnCorrect.addEventListener("click", async () => {
  if (!track?.points?.length) return;

  const resource = $("#resource-select").value;
  const batchSize = parseInt($("#batch-size").value, 10) || 200;

  btnCorrect.disabled = true;
  progressWrap.hidden = false;
  progressFill.style.width = "0%";
  progressText.textContent = "0 %";

  try {
    const elevations = await correctAllPoints(track.points, resource, batchSize, (done, total) => {
      const pct = Math.round((done / total) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${pct} % — ${done} / ${total} points`;
    });

    correctedPoints = track.points.map((p, i) => ({
      ...p,
      ele: elevations[i] != null ? elevations[i] : p.ele,
    }));

    updateStats(correctedPoints);
    renderProfile(correctedPoints);
    resultsSection.hidden = false;
    showToast("Correction terminée", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Erreur lors de la correction IGN", "error");
  } finally {
    btnCorrect.disabled = false;
    progressWrap.hidden = true;
  }
});

$("#btn-export-gpx").addEventListener("click", () => {
  if (!correctedPoints) return;
  const name = (track?.name || "trace") + " (corrigé)";
  const xml = buildGPX(name, correctedPoints);
  const fname = baseName(track.originalName || "trace") + "_corr.gpx";
  downloadBlob(new Blob([xml], { type: "application/gpx+xml" }), fname);
});

$("#btn-export-kml").addEventListener("click", () => {
  if (!correctedPoints) return;
  const name = (track?.name || "trace") + " (corrigé)";
  const xml = buildKML(name, correctedPoints);
  const fname = baseName(track.originalName || "trace") + "_corr.kml";
  downloadBlob(new Blob([xml], { type: "application/vnd.google-earth.kml+xml" }), fname);
});

const canvas = document.getElementById("editorCanvas");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("canvasStage");
const fileInput = document.getElementById("fileInput");
const emptyState = document.getElementById("emptyState");
const imageStatus = document.getElementById("imageStatus");
const zoomValue = document.getElementById("zoomValue");
const toast = document.getElementById("toast");

// أقصى عدد بكسلات يتحمله الكانفاس في Safari/iOS (16,777,216)
const MAX_PIXELS = 16000000;

let sourceImage = null; // الصورة كما رُفعت (لإعادة الضبط الكاملة)
let baseImage = null; // الصورة الحالية (تتغير بعد القص)
let fileName = "image";
let zoom = 1;
let rotation = 0;
let flipH = false;
let flipV = false;
let activeFilter = "normal";
let cropRatio = "free";
let textLayers = [];
let toastTimer;
let renderQueued = false;

const adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  blur: 0,
};

const filterPresets = {
  normal: [],
  grayscale: [["grayscale", 1]],
  sepia: [["sepia", 1]],
  vintage: [
    ["sepia", 0.45],
    ["contrast", 0.9],
    ["saturate", 0.75],
  ],
  warm: [
    ["sepia", 0.2],
    ["saturate", 1.35],
  ],
  cool: [
    ["hue-rotate", 18],
    ["saturate", 0.9],
  ],
  dramatic: [
    ["contrast", 1.35],
    ["saturate", 1.2],
  ],
  fade: [
    ["contrast", 0.82],
    ["brightness", 1.1],
    ["saturate", 0.75],
  ],
};

/* ---------- دعم ctx.filter (Safari/iOS لا يدعمه) ---------- */
const supportsCtxFilter = (() => {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const t = c.getContext("2d");
    if (!("filter" in t)) return false;
    t.filter = "invert(1)";
    t.fillRect(0, 0, 1, 1); // أسود → أبيض إذا اشتغل الفلتر
    return t.getImageData(0, 0, 1, 1).data[0] > 200;
  } catch (e) {
    return false;
  }
})();

/* ---------- أدوات مساعدة ---------- */
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function hasImage(quiet = false) {
  if (baseImage) return true;
  if (!quiet) showToast("اختَر صورة أولًا.");
  return false;
}

function dims(img) {
  return {
    w: img.naturalWidth || img.width,
    h: img.naturalHeight || img.height,
  };
}

function getBaseSize() {
  const { w, h } = dims(baseImage);
  return Math.abs(rotation % 180) === 90
    ? { width: h, height: w }
    : { width: w, height: h };
}

/* ---------- تحميل الصورة ---------- */
fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("من فضلك اختر ملف صورة.");
    fileInput.value = "";
    return;
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(url);
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (!w || !h) {
      showToast("تعذّر فتح الصورة.");
      return;
    }

    let src = image;
    let note = "";
    if (w * h > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / (w * h));
      const c = document.createElement("canvas");
      c.width = Math.floor(w * k);
      c.height = Math.floor(h * k);
      c.getContext("2d").drawImage(image, 0, 0, c.width, c.height);
      src = c;
      note = " (تم تصغيرها لتناسب حدود المتصفح)";
    }

    sourceImage = baseImage = src;
    fileName = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
    resetEditing(false);
    emptyState.hidden = true;
    canvas.hidden = false;
    renderImage();
    showToast("تم تحميل الصورة بنجاح." + note);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    showToast("تعذّر فتح الصورة.");
  };
  image.src = url;
  fileInput.value = ""; // للسماح باختيار نفس الملف مرة ثانية
});

/* ---------- الفلاتر ---------- */
function getFilterOps(size) {
  const ops = filterPresets[activeFilter].map(([name, value]) => ({
    name,
    value,
  }));
  const add = (name, value, neutral) => {
    if (value !== neutral) ops.push({ name, value });
  };
  add("brightness", (100 + adjustments.brightness) / 100, 1);
  add("contrast", (100 + adjustments.contrast) / 100, 1);
  add("saturate", (100 + adjustments.saturation) / 100, 1);
  add("hue-rotate", adjustments.hue, 0);
  // الضبابية نسبية لحجم الصورة حتى يكون تأثيرها ظاهرًا على الصور الكبيرة
  const blurPx =
    adjustments.blur * Math.max(1, Math.max(size.width, size.height) / 800);
  add("blur", blurPx, 0);
  return ops;
}

function opsToCss(ops) {
  return ops
    .map(({ name, value }) => {
      if (name === "hue-rotate") return `hue-rotate(${value}deg)`;
      if (name === "blur") return `blur(${value}px)`;
      return `${name}(${value})`;
    })
    .join(" ");
}

function colorMatrix(name, v) {
  if (name === "grayscale") {
    const s = 1 - Math.min(v, 1);
    return [
      0.2126 + 0.7874 * s,
      0.7152 - 0.7152 * s,
      0.0722 - 0.0722 * s,
      0.2126 - 0.2126 * s,
      0.7152 + 0.2848 * s,
      0.0722 - 0.0722 * s,
      0.2126 - 0.2126 * s,
      0.7152 - 0.7152 * s,
      0.0722 + 0.9278 * s,
    ];
  }
  if (name === "sepia") {
    const s = 1 - Math.min(v, 1);
    return [
      0.393 + 0.607 * s,
      0.769 - 0.769 * s,
      0.189 - 0.189 * s,
      0.349 - 0.349 * s,
      0.686 + 0.314 * s,
      0.168 - 0.168 * s,
      0.272 - 0.272 * s,
      0.534 - 0.534 * s,
      0.131 + 0.869 * s,
    ];
  }
  if (name === "saturate") {
    return [
      0.213 + 0.787 * v,
      0.715 - 0.715 * v,
      0.072 - 0.072 * v,
      0.213 - 0.213 * v,
      0.715 + 0.285 * v,
      0.072 - 0.072 * v,
      0.213 - 0.213 * v,
      0.715 - 0.715 * v,
      0.072 + 0.928 * v,
    ];
  }
  // hue-rotate
  const a = (v * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ];
}

function blurLine(src, dst, start, stride, len, r) {
  const win = 2 * r + 1;
  for (let ch = 0; ch < 4; ch++) {
    let sum = 0;
    for (let k = -r; k <= r; k++)
      sum += src[start + Math.min(len - 1, Math.max(0, k)) * stride + ch];
    for (let k = 0; k < len; k++) {
      dst[start + k * stride + ch] = sum / win;
      sum +=
        src[start + Math.min(len - 1, k + r + 1) * stride + ch] -
        src[start + Math.max(0, k - r) * stride + ch];
    }
  }
}

function boxBlur(data, w, h, r) {
  const tmp = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < 3; pass++) {
    // 3 مرات تقارب Gaussian blur
    for (let y = 0; y < h; y++) blurLine(data, tmp, y * w * 4, 4, w, r);
    for (let x = 0; x < w; x++) blurLine(tmp, data, x * 4, w * 4, h, r);
  }
}

// بديل يدوي للفلاتر عندما لا يدعم المتصفح ctx.filter
function applyFilterFallback(c2d, w, h, ops) {
  const colorOps = ops
    .filter((o) => o.name !== "blur")
    .map((o) => {
      if (o.name === "brightness") return { t: 0, a: o.value };
      if (o.name === "contrast") return { t: 1, a: o.value };
      return { t: 2, m: colorMatrix(o.name, o.value) };
    });
  const blur = ops.find((o) => o.name === "blur");
  const img = c2d.getImageData(0, 0, w, h);
  const d = img.data;

  if (colorOps.length) {
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255,
        g = d[i + 1] / 255,
        b = d[i + 2] / 255;
      for (let k = 0; k < colorOps.length; k++) {
        const op = colorOps[k];
        if (op.t === 0) {
          r *= op.a;
          g *= op.a;
          b *= op.a;
        } else if (op.t === 1) {
          r = (r - 0.5) * op.a + 0.5;
          g = (g - 0.5) * op.a + 0.5;
          b = (b - 0.5) * op.a + 0.5;
        } else {
          const m = op.m;
          const nr = m[0] * r + m[1] * g + m[2] * b;
          const ng = m[3] * r + m[4] * g + m[5] * b;
          const nb = m[6] * r + m[7] * g + m[8] * b;
          r = nr;
          g = ng;
          b = nb;
        }
        r = r < 0 ? 0 : r > 1 ? 1 : r;
        g = g < 0 ? 0 : g > 1 ? 1 : g;
        b = b < 0 ? 0 : b > 1 ? 1 : b;
      }
      d[i] = r * 255 + 0.5;
      d[i + 1] = g * 255 + 0.5;
      d[i + 2] = b * 255 + 0.5;
    }
  }
  if (blur) {
    const r = Math.round(blur.value);
    if (r >= 1) boxBlur(d, w, h, r);
  }
  c2d.putImageData(img, 0, 0);
}

/* ---------- الرسم ---------- */
function drawBase(target, w, h) {
  const { w: iw, h: ih } = dims(baseImage);
  target.save();
  target.translate(w / 2, h / 2);
  target.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  target.rotate((rotation * Math.PI) / 180);
  target.drawImage(baseImage, -iw / 2, -ih / 2);
  target.restore();
}

function renderImage() {
  if (!baseImage) return;
  const size = getBaseSize();
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const ops = getFilterOps(size);
  if (!ops.length) {
    drawBase(ctx, w, h);
  } else if (supportsCtxFilter) {
    ctx.filter = opsToCss(ops);
    drawBase(ctx, w, h);
    ctx.filter = "none";
  } else {
    drawBase(ctx, w, h);
    applyFilterFallback(ctx, w, h, ops);
  }

  // النص يُرسم بعد الفلاتر ليبقى واضحًا
  textLayers.forEach((layer) => {
    ctx.save();
    ctx.fillStyle = layer.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${layer.size}px ${layer.font}`;
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = Math.max(1, layer.size / 12);
    ctx.fillText(layer.text, w / 2, h / 2 + layer.offsetY, w * 0.92);
    ctx.restore();
  });

  imageStatus.textContent = `${w} × ${h}`;
  updateDisplaySize();
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderImage();
  });
}

// حجم العرض = ملاءمة المساحة × التكبير (بدل transform الذي كان يقص الصورة)
function updateDisplaySize() {
  if (!baseImage || canvas.hidden) return;
  const cs = getComputedStyle(stage);
  const pad = (a, b) => parseFloat(cs[a]) + parseFloat(cs[b]);
  const availW =
    stage.offsetWidth -
    pad("paddingLeft", "paddingRight") -
    pad("borderLeftWidth", "borderRightWidth");
  const availH =
    stage.offsetHeight -
    pad("paddingTop", "paddingBottom") -
    pad("borderTopWidth", "borderBottomWidth");
  const fit = Math.min(1, availW / canvas.width, availH / canvas.height);
  canvas.style.width = `${Math.max(1, canvas.width * fit * zoom)}px`;
  canvas.style.height = `${Math.max(1, canvas.height * fit * zoom)}px`;
  zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}
window.addEventListener("resize", updateDisplaySize);

/* ---------- الأحداث ---------- */
document.querySelectorAll(".filter-card").forEach((button) => {
  button.addEventListener("click", () => {
    if (!hasImage()) return;
    activeFilter = button.dataset.filter;
    document
      .querySelectorAll(".filter-card")
      .forEach((item) => item.classList.toggle("active", item === button));
    renderImage();
  });
});

document.querySelectorAll("[data-adjust]").forEach((input) => {
  input.addEventListener("input", () => {
    adjustments[input.dataset.adjust] = Number(input.value);
    document.getElementById(`${input.dataset.adjust}Out`).textContent =
      input.dataset.adjust === "hue" ? `${input.value}°` : input.value;
    if (hasImage(true)) requestRender();
  });
});

document.getElementById("rotateLeft").addEventListener("click", () => {
  if (!hasImage()) return;
  rotation = (rotation - 90 + 360) % 360;
  renderImage();
});
document.getElementById("rotateRight").addEventListener("click", () => {
  if (!hasImage()) return;
  rotation = (rotation + 90) % 360;
  renderImage();
});
document.getElementById("flipH").addEventListener("click", () => {
  if (!hasImage()) return;
  flipH = !flipH;
  renderImage();
});
document.getElementById("flipV").addEventListener("click", () => {
  if (!hasImage()) return;
  flipV = !flipV;
  renderImage();
});

document.getElementById("cropRatio").addEventListener("change", (event) => {
  cropRatio = event.target.value;
});

document.getElementById("cropBtn").addEventListener("click", () => {
  if (!hasImage()) return;
  if (cropRatio === "free") {
    showToast("الصورة بالفعل على أبعادها الحالية.");
    return;
  }

  const [ratioW, ratioH] = cropRatio.split(":").map(Number);
  const targetRatio = ratioW / ratioH;
  const w = canvas.width,
    h = canvas.height;
  let cropWidth = w;
  let cropHeight = h;
  if (w / h > targetRatio) cropWidth = Math.round(h * targetRatio);
  else cropHeight = Math.round(w / targetRatio);
  if (cropWidth === w && cropHeight === h) {
    showToast("الصورة بالفعل على هذه النسبة.");
    return;
  }

  // نقص الصورة بعد التدوير/القلب فقط (بدون فلاتر ولا نص) فتبقى التعديلات قابلة للتغيير
  const geo = document.createElement("canvas");
  geo.width = w;
  geo.height = h;
  drawBase(geo.getContext("2d"), w, h);

  const cropped = document.createElement("canvas");
  cropped.width = cropWidth;
  cropped.height = cropHeight;
  cropped
    .getContext("2d")
    .drawImage(
      geo,
      Math.floor((w - cropWidth) / 2),
      Math.floor((h - cropHeight) / 2),
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );

  baseImage = cropped;
  rotation = 0;
  flipH = false;
  flipV = false;
  cropRatio = "free";
  document.getElementById("cropRatio").value = "free";
  renderImage();
  showToast("تم تطبيق القص.");
});

document.getElementById("addTextBtn").addEventListener("click", () => {
  if (!hasImage()) return;
  const text = document.getElementById("textInput").value.trim();
  if (!text) {
    showToast("اكتب النص الذي تريد إضافته.");
    return;
  }
  const size = Math.max(
    10,
    Math.min(160, Number(document.getElementById("fontSize").value) || 32),
  );
  // الحجم نسبي لأبعاد الصورة حتى لا يظهر النص صغيرًا جدًا على الصور الكبيرة
  const px = Math.round(
    size * Math.max(1, Math.max(canvas.width, canvas.height) / 900),
  );
  const last = textLayers[textLayers.length - 1];
  textLayers.push({
    text,
    size: px,
    font: document.getElementById("fontFamily").value,
    color: document.getElementById("textColor").value,
    offsetY: last
      ? last.offsetY + Math.round(Math.max(last.size, px) * 1.3)
      : 0,
  });
  renderImage();
  showToast("تمت إضافة النص إلى الصورة.");
});

function resetEditing(showMessage = true) {
  baseImage = sourceImage; // يرجّع الصورة الأصلية حتى لو تم القص
  rotation = 0;
  flipH = false;
  flipV = false;
  activeFilter = "normal";
  cropRatio = "free";
  textLayers = [];
  Object.keys(adjustments).forEach((key) => {
    adjustments[key] = 0;
    document.getElementById(key).value = 0;
    document.getElementById(`${key}Out`).textContent =
      key === "hue" ? "0°" : "0";
  });
  document.getElementById("cropRatio").value = "free";
  document.getElementById("textInput").value = "";
  document
    .querySelectorAll(".filter-card")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.filter === "normal"),
    );
  zoom = 1;
  if (baseImage) renderImage();
  if (showMessage) showToast("تمت إعادة ضبط التعديلات.");
}

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!hasImage()) return;
  resetEditing(true);
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!hasImage()) return;
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast("تعذّر تحميل الصورة. جرّب صورة أصغر.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${fileName}-edited.png`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    showToast("بدأ تحميل الصورة.");
  }, "image/png");
});

function setZoom(next) {
  zoom = Math.round(Math.max(0.25, Math.min(2.5, next)) * 100) / 100;
  updateDisplaySize();
}
document
  .getElementById("zoomIn")
  .addEventListener("click", () => setZoom(zoom + 0.1));
document
  .getElementById("zoomOut")
  .addEventListener("click", () => setZoom(zoom - 0.1));
document.getElementById("fitBtn").addEventListener("click", () => setZoom(1));
document
  .getElementById("fitBtnBottom")
  .addEventListener("click", () => setZoom(1));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .catch((error) => console.error(error));
}

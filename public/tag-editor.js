import { state } from './state.js';
import { ICONS, refreshEntityTags } from './utils.js';
import { toast } from './toast.js';
import { kindFor, thumbUrl } from './kinds.js';
import { mountModal } from './modal.js';

// Tags live on instances. The grid's edit affordance targets the first
// instance (the common case is a single-instance entity, where that's
// everything); the lightbox and rows-mode tiles pass the instance the user
// is looking at.
export function openTagEditor(img, inst = img.instances?.[0]) {
  const overlay = document.createElement("div");
  overlay.className = "te-overlay";

  const dialog = document.createElement("div");
  dialog.className = "te-dialog";

  const header = document.createElement("div");
  header.className = "te-header";
  const thumb = document.createElement("img");
  // The TARGET instance drives the preview — editing one photo of four must
  // show that photo, not the entity face (they diverge whenever the face
  // config isn't first-added). No preview for the target → no thumb; the
  // entity face here would just be the wrong picture.
  const preview = inst
    ? (inst.w && inst.h ? thumbUrl(inst.name) : null)
    : kindFor(img).previewUrl?.(img);
  if (preview) thumb.src = preview;
  else thumb.hidden = true;
  thumb.className = "te-thumb";
  const closeBtn = document.createElement("button");
  closeBtn.className = "te-close";
  closeBtn.textContent = "×";
  header.append(thumb, closeBtn);

  const body = document.createElement("div");
  body.className = "te-body";

  const checkMap = new Map();
  for (const f of state.facets) {
    const group = document.createElement("div");
    group.className = "te-group";
    const lbl = document.createElement("div");
    lbl.className = "te-group-label";
    lbl.textContent = f.label + (f.single ? " — pick one" : "");
    group.appendChild(lbl);
    const pills = document.createElement("div");
    pills.className = "te-pills";
    const cbMap = {};
    for (const v of f.values) {
      const pill = document.createElement("label");
      pill.className = "te-val";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = (inst?.tagSet || img.tagSet).has(`${f.key}/${v}`);
      if (f.single) {
        cb.addEventListener("change", () => {
          if (cb.checked) {
            for (const [ov, ocb] of Object.entries(cbMap)) { if (ov !== v) ocb.checked = false; }
          }
        });
      }
      const sp = document.createElement("span");
      sp.textContent = v;
      pill.append(cb, sp);
      pills.appendChild(pill);
      cbMap[v] = cb;
    }
    checkMap.set(f.key, cbMap);
    group.appendChild(pills);
    body.appendChild(group);
  }

  const footer = document.createElement("div");
  footer.className = "te-footer";
  const saveBtn = document.createElement("button");
  saveBtn.className = "te-save";
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "te-cancel";
  cancelBtn.textContent = "Cancel";
  footer.append(saveBtn, cancelBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  const close = mountModal({ overlay, dialog });
  closeBtn.onclick = close;
  cancelBtn.onclick = close;

  saveBtn.addEventListener("click", async () => {
    const tags = [];
    for (const f of state.facets) {
      const cbMap = checkMap.get(f.key) || {};
      for (const [v, cb] of Object.entries(cbMap)) if (cb.checked) tags.push(`${f.key}/${v}`);
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      if (!inst) throw new Error();
      const r = await fetch(`/api/instances/${inst.id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!r.ok) throw new Error();
      const { tags: saved } = await r.json();
      inst.tags = saved;
      inst.tagSet = new Set(saved);
      inst.status = "tagged";
      inst.undecided = false;
      refreshEntityTags(img);
      if (img.instances.every((i) => i.status === "tagged" || i.status === "failed")) img.status = "tagged";
      close();
      document.dispatchEvent(new Event('app:render'));
    } catch {
      toast.error("Couldn't save tags");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
}

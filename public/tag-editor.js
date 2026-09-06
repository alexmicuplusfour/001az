import { state } from './state.js';
import { ICONS, refreshEntityTags } from './utils.js';
import { applyRoutedEntities } from './data.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { kindFor, thumbUrl } from './kinds.js';
import { mountModal, busy } from './modal.js';

// Tags live on instances. The grid's edit affordance targets the first
// instance (the common case is a single-instance entity, where that's
// everything); the lightbox and rows-mode tiles pass the instance the user
// is looking at.
export function openTagEditor(item, inst = item.instances?.[0]) {
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
    : kindFor(item).previewUrl?.(item);
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
      cb.checked = (inst?.tagSet || item.tagSet).has(`${f.key}/${v}`);
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

  saveBtn.addEventListener("click", busy(saveBtn, async () => {
    const tags = [];
    for (const f of state.facets) {
      const cbMap = checkMap.get(f.key) || {};
      for (const [v, cb] of Object.entries(cbMap)) if (cb.checked) tags.push(`${f.key}/${v}`);
    }
    try {
      if (!inst) throw new Error();
      const { tags: saved, entities } = await api("PATCH", `/api/instances/${inst.id}/tags`, { tags });
      // The modal can outlive a poll tick, and reconcile swaps item.instances
      // for fresh objects — write the server's answer onto the entity's
      // CURRENT instance, not the captured one, or refreshEntityTags below
      // recomputes the union from objects that never saw the edit and the
      // save looks lost until a reload. Fallback to the captured object
      // (instance deleted elsewhere) keeps this a no-op on a dead entity.
      const live = item.instances?.find((x) => x.id === inst.id) || inst;
      live.tags = saved;
      live.tagSet = new Set(saved);
      live.undecided = false;
      refreshEntityTags(item);
      // Statuses come from the routed report — the server's aggregate rule,
      // not a client re-derivation (the old every() here called all-tagged-
      // plus-one-failed "tagged" where STATUS_PRIORITY says "failed").
      applyRoutedEntities(entities);
      close();
      document.dispatchEvent(new Event('app:render'));
    } catch {
      toast.error("Couldn't save tags");
    }
  }));
}

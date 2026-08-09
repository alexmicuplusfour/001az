// Profile page: any signed-in member's own settings. Mirrors the admin
// shell's gate pattern — /api/me flips #profile-ui visible or bounces to login.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { ICONS } from "/utils.js";
import { createCheckbox } from "/checkbox.js";
import { chime, soundOn, setSoundOn } from "/chime.js";

// The rail names its glyphs in data-icon; fill them in before the gate resolves
// so nothing renders half-drawn. Mirrors admin.js.
for (const el of document.querySelectorAll("[data-icon]")) {
  el.insertAdjacentHTML("afterbegin", ICONS[el.dataset.icon]);
}

const me = await fetch("/api/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
if (!me) {
  location.replace("/login.html?next=%2Fprofile.html");
} else {
  document.getElementById("gate").hidden = true;
  document.getElementById("profile-ui").hidden = false;

  const input = document.getElementById("name-input");
  input.value = me.name || "";

  document.getElementById("name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const { name } = await api("PATCH", "/api/account", { name: input.value });
      input.value = name || "";
      toast("Name updated");
    } catch (err) {
      toast.error(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // The header dots' tone. It lives here rather than in the gallery's user menu
  // because it is a preference, not an action, and this is the page of the
  // reader's own preferences — the menu beside it is doors and a sign-out.
  //
  // Kept local (chime.js reads localStorage) rather than sent to /api/account:
  // this settles how loud one BROWSER is, so following the reader to another
  // device is the wrong behaviour, not a missing one.
  //
  // Turning it ON plays the tone. It confirms what was just enabled, and it is
  // a click — which is what the browser's autoplay policy wants to see before it
  // will let the first real notification through, so the confirmation and the
  // unlock are the same gesture.
  //
  // `onChange` is the raw change listener (checkbox.js), so the new state is
  // read off the handle rather than off an argument: an Event is truthy, and a
  // toggle that tested one could only ever turn the sound on.
  const sound = createCheckbox({
    variant: "light",
    label: "Play a sound",
    checked: soundOn(),
    onChange: () => { setSoundOn(sound.checked); if (sound.checked) chime(); },
  });
  document.getElementById("sound-row").appendChild(sound.el);
}

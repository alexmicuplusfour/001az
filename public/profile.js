// Profile page: any signed-in member's own settings. Mirrors the admin
// shell's gate pattern — /api/me flips #profile-ui visible or bounces to login.
import { toast } from "/toast.js";
import { api } from "/api.js";

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
}

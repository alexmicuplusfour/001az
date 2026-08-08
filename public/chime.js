// One sound, for all three header signals.
//
// Deliberately ONE tone rather than a vocabulary: three sounds would have to be
// learned, and nothing here is urgent enough to earn that. It plays on the same
// edge the toast does — when a dot LIGHTS, not while it stays lit — so a burst
// of failures is one chime, not eight.
//
// Sound is also the only part of this feature that reaches someone who isn't
// looking at the tab, which is exactly why the off switch sits in the user menu
// rather than behind a settings page nobody opens.
const SRC = "/notification.mp3";
const KEY = "notifySound";

// On unless explicitly turned off. An unset preference should behave like the
// feature was asked for, and the dots are quiet enough to miss on their own.
export const soundOn = () => localStorage.getItem(KEY) !== "off";
export const setSoundOn = (on) => localStorage.setItem(KEY, on ? "on" : "off");

let el = null;

export function chime() {
  if (!soundOn()) return;
  // Built on first use, so a tab that never gets news — or has the sound off —
  // never fetches the file at all.
  if (!el) {
    el = new Audio(SRC);
    el.volume = 0.35; // a notification, not an alarm
  }
  el.currentTime = 0; // a second chime during the first must restart it, not be dropped
  // Autoplay policy: a tab the user has not yet clicked in REFUSES to play, and
  // the refusal arrives as a rejected promise — left alone it surfaces in the
  // console as an error about a feature working exactly as specified. Swallow
  // it. The toast and the dot have already said the same thing visually, which
  // is why the sound is allowed to be the part that doesn't always arrive.
  el.play?.()?.catch(() => {});
}

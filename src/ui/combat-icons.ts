const svg = (body: string) => `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${body}</svg>`;
export const COMBAT_ICONS = {
  punch: svg('<path fill="currentColor" d="M15 30V18a5 5 0 0 1 10 0v-3a5 5 0 0 1 10 0v2a5 5 0 0 1 10 0v4a5 5 0 0 1 10 0v17c0 7-4 12-10 16v5H24v-7L11 38a6 6 0 0 1 8-9l8 6v-6H15Z"/><path d="M25 20v9m10-11v11m10-6v7M24 51h21" fill="none" stroke="#26302d" stroke-width="3" stroke-linecap="round"/>'),
  kick: svg('<circle cx="27" cy="9" r="6" fill="currentColor"/><path d="m26 21-5 17-8 17m9-19 16-6 16-12M25 21l-12 3-7-6m19 5 10-2 7 5" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'),
  smg: svg('<path fill="currentColor" d="M2 21h9l4 4h5v-5h21l5-3h9v3h8v4h-8v3H43l-4 3h-9l-3 16h-9l2-16h-7l-4 5H2v-5h5l3-4H2Z"/>'),
  fire: svg('<circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="32" cy="32" r="5" fill="currentColor"/><path d="M32 5v14m0 26v14M5 32h14m26 0h14" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'),
};

const { ipcRenderer } = require('electron');

ipcRenderer.on('update-osd-data', (event, data) => {
  const nowEl = document.getElementById('now');
  const nextEl = document.getElementById('next');
  const relicEl = document.getElementById('relic');
  const relicRow = document.getElementById('relic-row');

  if (nowEl) nowEl.textContent = data.now;
  if (nextEl) nextEl.textContent = data.next;

  if (relicEl && relicRow) {
    if (data.relic && data.relic.trim() !== "") {
      relicEl.textContent = data.relic;
      relicRow.style.display = "flex";
    } else {
      relicRow.style.display = "none";
    }
  }
});

ipcRenderer.on('update-osd-style', (event, style) => {
  if (style.opacity !== undefined) {
    const wrapper = document.getElementById('osd-wrapper');
    if (wrapper) {
      wrapper.style.backgroundColor = `rgba(9, 9, 11, ${style.opacity})`;
    }
  }
});

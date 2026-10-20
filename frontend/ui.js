window.FinanceUI = (() => {
  let nextDialogId = 0;
  function ask(message, { title = 'Please confirm', action = 'Continue', amount = false } = {}) {
    const dialog = document.createElement('dialog');
    const titleId = `action-dialog-title-${++nextDialogId}`;
    dialog.className = 'editor action-dialog';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">MYFINANCE / WORKSPACE</p>
      <h2 id="${titleId}"></h2><p class="muted"></p>
      ${amount ? '<label>Amount ($)<input name="amount" type="number" min="0.01" step="0.01" required autofocus></label>' : ''}
      <div class="toolbar"><button class="btn btn-secondary" type="button">Cancel</button><button class="btn btn-primary" value="confirm"></button></div>
    </form>`;
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('.muted').textContent = message;
    dialog.querySelector('.btn-primary').textContent = action;
    dialog.querySelector('.btn-secondary').onclick = () => dialog.close();
    document.body.appendChild(dialog);
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'confirm';
        const value = amount ? (accepted ? dialog.querySelector('input').value : null) : accepted;
        dialog.remove();
        resolve(value);
      }, { once: true });
      dialog.showModal();
    });
  }
  document.addEventListener('click', event => {
    const dialog = event.target;
    if (dialog.tagName !== 'DIALOG' || !dialog.open) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const dialog = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
    if (dialog) {
      event.preventDefault();
      dialog.close();
    }
  });
  function howCalc(text, label = 'How is this calculated?') {
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    return `<button type="button" class="how-calc" data-calculation="${esc(text)}" data-calculation-title="${esc(label)}" aria-label="${esc(label)}" aria-haspopup="dialog" title="${esc(label)}"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6v1"/></svg></button>`;
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('button[data-calculation]');
    if (!trigger) return;
    const dialog = document.createElement('dialog');
    const id = `calculation-dialog-${++nextDialogId}`;
    dialog.className = 'editor calculation-dialog';
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-body`);
    dialog.innerHTML = `<form method="dialog"><h2 id="${id}-title"></h2><p id="${id}-body"></p><button type="submit" class="btn btn-primary" autofocus>Got it</button></form>`;
    const context = trigger.parentElement?.textContent.trim();
    dialog.querySelector('h2').textContent = trigger.dataset.calculationTitle === 'How is this calculated?' && context
      ? `${context} - calculation` : trigger.dataset.calculationTitle;
    dialog.querySelector('p').textContent = trigger.dataset.calculation;
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); trigger.focus({ preventScroll: true }); }, { once: true });
    dialog.showModal();
  });
  return {
    confirm: (message, options) => ask(message, options),
    amount: message => ask(message, { title: 'Record savings', action: 'Record savings', amount: true }),
    howCalc
  };
})();

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
  return {
    confirm: (message, options) => ask(message, options),
    amount: message => ask(message, { title: 'Record savings', action: 'Record savings', amount: true })
  };
})();

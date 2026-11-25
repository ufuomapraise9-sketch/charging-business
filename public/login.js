const form = document.querySelector('#login-form');
const errorMessage = document.querySelector('#login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button');
  submit.disabled = true;
  errorMessage.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not sign in.');
    window.location.replace('/');
  } catch (error) {
    errorMessage.textContent = error.message || 'Could not reach the server. Try again.';
  } finally {
    submit.disabled = false;
  }
});

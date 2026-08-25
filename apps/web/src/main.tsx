import '@bsync/ui/styles.css';
import { render } from 'preact';
import { App } from './App';
import './styles.css';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('BSync app root is missing');
render(<App />, root);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}

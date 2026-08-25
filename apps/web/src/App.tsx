import { Layout } from './components';
import { InvitePage } from './pages/InvitePage';
import { LandingPage } from './pages/LandingPage';
import { PrivacyPage } from './pages/PrivacyPage';

function routeFor(pathname: string): 'home' | 'invite' | 'privacy' | 'missing' {
  const normalized = pathname.replace(/\/index\.html$/u, '').replace(/\/$/u, '') || '/';
  if (normalized === '/') return 'home';
  if (normalized === '/invite') return 'invite';
  if (normalized === '/privacy') return 'privacy';
  return 'missing';
}

export function App() {
  const route = routeFor(window.location.pathname);
  return (
    <Layout>
      {route === 'home' && <LandingPage />}
      {route === 'invite' && <InvitePage />}
      {route === 'privacy' && <PrivacyPage />}
      {route === 'missing' && <section class="not-found"><p class="eyebrow"><span>404</span> Route missing</p><h1>Signal not found.</h1><a class="bsync-button" href="/">Return home</a></section>}
    </Layout>
  );
}

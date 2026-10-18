import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { EditorPage } from './pages/EditorPage';

function AppContent() {
  const { user, isLoading } = useAuth();
  const [authView, setAuthView] = useState<'login' | 'register'>('login');
  const [currentDocId, setCurrentDocId] = useState<string | null>(null);

  // Sync document ID with window location hash for easy reload/navigation
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash.startsWith('doc/')) {
        const id = hash.replace('doc/', '');
        setCurrentDocId(id);
      } else {
        setCurrentDocId(null);
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const openDocument = (id: string) => {
    window.location.hash = `doc/${id}`;
    setCurrentDocId(id);
  };

  const closeDocument = () => {
    window.location.hash = '';
    setCurrentDocId(null);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center space-y-4">
        <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-slate-400 font-medium">Initializing CollabSync session...</p>
      </div>
    );
  }

  // Not authenticated
  if (!user) {
    if (authView === 'register') {
      return <RegisterPage onSwitchToLogin={() => setAuthView('login')} />;
    }
    return <LoginPage onSwitchToRegister={() => setAuthView('register')} />;
  }

  // Active document editor view
  if (currentDocId) {
    return <EditorPage docId={currentDocId} onBack={closeDocument} />;
  }

  // Default: Dashboard
  return <DashboardPage onOpenDoc={openDocument} />;
}

export function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;

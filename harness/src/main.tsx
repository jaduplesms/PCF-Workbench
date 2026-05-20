import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installXrmFormShim } from './shim/xrm-form';
import { installTestBridge } from './test-bridge';

installXrmFormShim();
installTestBridge();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

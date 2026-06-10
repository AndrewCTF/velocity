import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './AppRouter.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Popup } from './Popup.tsx';
import './styles.css';

/**
 * One renderer, two windows: the main window asks for nothing, and `?popup=1` asks for the
 * quick window. The same panes, the same commands, the same confirmation sheet — a second
 * implementation of any of them would be a second thing to keep right.
 */
const isPopup = new URLSearchParams(window.location.search).get('popup') === '1';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(<StrictMode>{isPopup ? <Popup /> : <App />}</StrictMode>);

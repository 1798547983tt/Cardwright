import React from 'react';
import { createRoot } from 'react-dom/client';
import { PetWindow } from './PetWindow';
import '../tokens.css';
import './pet.css';

createRoot(document.getElementById('pet')!).render(<React.StrictMode><PetWindow /></React.StrictMode>);

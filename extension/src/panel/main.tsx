import './tailwind.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const el = document.getElementById('root')
if (!el) throw new Error('panel root missing')
createRoot(el).render(<App />)

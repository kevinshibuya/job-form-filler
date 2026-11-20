import '../panel/tailwind.css'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from './SettingsPage'

const el = document.getElementById('root')
if (!el) throw new Error('settings root missing')
createRoot(el).render(<SettingsPage />)

// app/renderer/themes.js
const THEMES = {
    matrix: {
        name: "Matrix",
        colors: {
            '--bg-primary': '#0d0208',
            '--bg-secondary': '#001a00',
            '--bg-tertiary': '#003300',
            '--text-primary': '#00ff41',
            '--text-secondary': '#00cc33',
            '--text-tertiary': '#008f11',
            '--accent': '#39ff14',
            '--accent-hover': '#00ff41',
            '--border': '#003300',
            '--shadow': 'rgba(0, 255, 65, 0.2)',
            '--error': '#ff0055',
            '--warning': '#ffaa00',
            '--success': '#00ff41',
            '--scrollbar-track': '#001a00',
            '--scrollbar-thumb': '#00cc33',
            '--code-bg': '#000d00',
            '--selection-bg': 'rgba(0, 255, 65, 0.3)',
        },
        effects: {
            '--glow': '0 0 10px rgba(0, 255, 65, 0.5)',
            '--text-glow': '0 0 5px rgba(0, 255, 65, 0.8)',
            '--box-shadow': '0 4px 20px rgba(0, 255, 65, 0.15)',
        },
        font: "'Courier New', 'Consolas', monospace"
    },

    dark: {
        name: "Dark",
        colors: {
            '--bg-primary': '#1e1e1e',
            '--bg-secondary': '#252526',
            '--bg-tertiary': '#2d2d30',
            '--text-primary': '#d4d4d4',
            '--text-secondary': '#cccccc',
            '--text-tertiary': '#969696',
            '--accent': '#0e639c',
            '--accent-hover': '#1177bb',
            '--border': '#3e3e42',
            '--shadow': 'rgba(0, 0, 0, 0.5)',
            '--error': '#f48771',
            '--warning': '#cca700',
            '--success': '#89d185',
            '--scrollbar-track': '#1e1e1e',
            '--scrollbar-thumb': '#424242',
            '--code-bg': '#1e1e1e',
            '--selection-bg': 'rgba(14, 99, 156, 0.4)',
        },
        effects: {
            '--glow': 'none',
            '--text-glow': 'none',
            '--box-shadow': '0 2px 8px rgba(0, 0, 0, 0.3)',
        },
        font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    },

    light: {
        name: "Light",
        colors: {
            '--bg-primary': '#ffffff',
            '--bg-secondary': '#f3f3f3',
            '--bg-tertiary': '#e8e8e8',
            '--text-primary': '#1e1e1e',
            '--text-secondary': '#333333',
            '--text-tertiary': '#666666',
            '--accent': '#0066cc',
            '--accent-hover': '#0052a3',
            '--border': '#d0d0d0',
            '--shadow': 'rgba(0, 0, 0, 0.1)',
            '--error': '#d32f2f',
            '--warning': '#f57c00',
            '--success': '#388e3c',
            '--scrollbar-track': '#f3f3f3',
            '--scrollbar-thumb': '#c0c0c0',
            '--code-bg': '#f5f5f5',
            '--selection-bg': 'rgba(0, 102, 204, 0.2)',
        },
        effects: {
            '--glow': 'none',
            '--text-glow': 'none',
            '--box-shadow': '0 2px 8px rgba(0, 0, 0, 0.08)',
        },
        font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    },

    cyberpunk: {
        name: "Cyberpunk",
        colors: {
            '--bg-primary': '#0a0e27',
            '--bg-secondary': '#16213e',
            '--bg-tertiary': '#1a1a2e',
            '--text-primary': '#f72585',
            '--text-secondary': '#b5179e',
            '--text-tertiary': '#7209b7',
            '--accent': '#4cc9f0',
            '--accent-hover': '#4361ee',
            '--border': '#560bad',
            '--shadow': 'rgba(247, 37, 133, 0.3)',
            '--error': '#ff006e',
            '--warning': '#ffbe0b',
            '--success': '#06ffa5',
            '--scrollbar-track': '#16213e',
            '--scrollbar-thumb': '#b5179e',
            '--code-bg': '#0a0e27',
            '--selection-bg': 'rgba(76, 201, 240, 0.3)',
        },
        effects: {
            '--glow': '0 0 15px rgba(247, 37, 133, 0.6)',
            '--text-glow': '0 0 8px rgba(247, 37, 133, 0.9)',
            '--box-shadow': '0 4px 20px rgba(76, 201, 240, 0.2)',
        },
        font: "'Courier New', 'Consolas', monospace"
    }
};

class ThemeManager {
    constructor() {
        this.currentTheme = localStorage.getItem('app-theme') || 'matrix';
        this.applyTheme(this.currentTheme);
        this.setupMatrixEffect();
    }

    applyTheme(themeName) {
        const theme = THEMES[themeName];
        if (!theme) return;

        const root = document.documentElement;

        Object.entries(theme.colors).forEach(([key, value]) => {
            root.style.setProperty(key, value);
        });

        Object.entries(theme.effects).forEach(([key, value]) => {
            root.style.setProperty(key, value);
        });

        root.style.setProperty('--font-family', theme.font);

        this.currentTheme = themeName;
        localStorage.setItem('app-theme', themeName);

        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: themeName } }));

        if (themeName === 'matrix') {
            this.enableMatrixEffect();
        } else {
            this.disableMatrixEffect();
        }
    }

    getAvailableThemes() {
        return Object.entries(THEMES).map(([id, theme]) => ({
            id,
            name: theme.name
        }));
    }

    getCurrentTheme() {
        return this.currentTheme;
    }

    setupMatrixEffect() {
        const canvas = document.createElement('canvas');
        canvas.id = 'matrix-canvas';
        canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: -1;
      opacity: 0;
      transition: opacity 0.5s;
    `;
        document.body.prepend(canvas);

        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const chars = 'ｱｲｳｴｵ...01';
        const fontSize = 14;
        const columns = canvas.width / fontSize;
        const drops = Array(Math.floor(columns)).fill(1);

        this.matrixAnimation = () => {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = '#00ff41';
            ctx.font = `${fontSize}px monospace`;

            for (let i = 0; i < drops.length; i++) {
                const text = chars[Math.floor(Math.random() * chars.length)];
                ctx.fillText(text, i * fontSize, drops[i] * fontSize);

                if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                    drops[i] = 0;
                }
                drops[i]++;
            }
        };

        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    }

    enableMatrixEffect() {
        const canvas = document.getElementById('matrix-canvas');
        if (canvas) {
            canvas.style.opacity = '0.15';
            if (!this.matrixInterval) {
                this.matrixInterval = setInterval(this.matrixAnimation, 50);
            }
        }
    }

    disableMatrixEffect() {
        const canvas = document.getElementById('matrix-canvas');
        if (canvas) {
            canvas.style.opacity = '0';
        }
        if (this.matrixInterval) {
            clearInterval(this.matrixInterval);
            this.matrixInterval = null;
        }
    }
}

window.themeManager = new ThemeManager();
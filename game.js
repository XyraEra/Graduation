/**
 * Game Engine Manager
 * Coordinates the states, visual assets rendering, particle simulations,
 * and Polaroid exports based on tracked MediaPipe keypoints.
 */

const GAME_STATES = {
    LOADING: 0,
    CLAP_1: 1,    // UI: 'Clap!' -> Spawns Gown
    CLAP_2: 2,    // UI: 'Clap Again!' -> Drops Cap
    CLAP_3: 3,    // UI: 'Clap Again!' -> Places Degree
    DANCE: 4,     // UI: 'Dance!' -> Confetti, Balloons, Caps falling
    CELEBRATION: 5 // Photo capture available
};

class GameEngine {
    constructor() {
        this.state = GAME_STATES.LOADING;
        this.video = document.getElementById('webcam');
        this.canvas = document.getElementById('output-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.uiText = document.getElementById('instruction-text');
        this.captureBtn = document.getElementById('capture-btn');
        
        // Asset Preloading with corrected subfolder paths
        this.assets = {
            gown: new Image(),
            cap: new Image(),
            degree: new Image()
        };
        
        this.assets.gown.src = 'Assets/Gown.png';
        this.assets.cap.src = 'Assets/Cap.png';
        this.assets.degree.src = 'Assets/Degree.png';

        // Tracking & Animation variables
        this.currentLandmarks = null;
        this.particles = [];
        this.balloons = [];
        this.fallingCaps = [];
        
        // Animation Interpolation Targets
        this.capDropY = -200; // Falling cap initialization height
        
        this.init();
    }

    init() {
        let loadedCount = 0;
        const totalAssets = Object.keys(this.assets).length;
        
        const onAssetLoaded = () => {
            loadedCount++;
            if (loadedCount === totalAssets) {
                console.log("All graphic assets loaded successfully!");
                this.state = GAME_STATES.CLAP_1;
                this.updateUI();
                this.startTracking();
            }
        };

        // Fallback error handling to pinpoint directory issues visually
        const onAssetError = (e) => {
            const failedSrc = e.target.src.split('/').pop();
            this.uiText.innerHTML = `⚠️ Error: Could not load <b style="color: #ff4a4a;">${failedSrc}</b>.<br><span style="font-size: 1.5rem;">Check if the file is inside the Assets folder with correct casing.</span>`;
            this.uiText.style.animation = "none";
        };

        for (let key in this.assets) {
            this.assets[key].onload = onAssetLoaded;
            this.assets[key].onerror = onAssetError;
        }

        // Setup custom event listeners tied to bodytracking.js triggers
        window.addEventListener('gesture-clap', () => this.handleClapEvent());
        window.addEventListener('gesture-dance', () => this.handleDanceEvent());
        
        this.setupModalEvents();
    }

    startTracking() {
        this.tracker = new BodyTracker(this.video, (results) => {
            this.currentLandmarks = results.poseLandmarks;
            this.renderLoop(results);
        });
        this.tracker.start();
    }

    updateUI() {
        switch (this.state) {
            case GAME_STATES.CLAP_1:
                this.uiText.innerText = "Clap!";
                break;
            case GAME_STATES.CLAP_2:
                this.uiText.innerText = "Clap Again!";
                break;
            case GAME_STATES.CLAP_3:
                this.uiText.innerText = "Clap Again!";
                break;
            case GAME_STATES.DANCE:
                this.uiText.innerText = "Dance!";
                break;
            case GAME_STATES.CELEBRATION:
                this.uiText.innerText = "You Did It!";
                this.captureBtn.classList.remove('hidden');
                break;
        }
    }

    handleClapEvent() {
        if (this.state === GAME_STATES.CLAP_1) {
            this.state = GAME_STATES.CLAP_2;
        } else if (this.state === GAME_STATES.CLAP_2) {
            this.state = GAME_STATES.CLAP_3;
        } else if (this.state === GAME_STATES.CLAP_3) {
            this.state = GAME_STATES.DANCE;
            this.spawnCelebrationElements();
        }
        this.updateUI();
    }

    handleDanceEvent() {
        if (this.state === GAME_STATES.DANCE) {
            // Sustain party physics metrics
            if(this.particles.length < 50) this.spawnCelebrationElements();
            
            // Advance state to capture mode after sufficient movement duration
            setTimeout(() => {
                if (this.state === GAME_STATES.DANCE) {
                    this.state = GAME_STATES.CELEBRATION;
                    this.updateUI();
                }
            }, 5000);
        }
    }

    spawnCelebrationElements() {
        // Spawn Gold & Black Confetti particles
        for (let i = 0; i < 100; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * -50,
                size: Math.random() * 8 + 4,
                color: Math.random() > 0.5 ? '#d4af37' : '#000000',
                speedY: Math.random() * 4 + 2,
                speedX: Math.random() * 2 - 1,
                rotation: Math.random() * 360,
                rotSpeed: Math.random() * 4 - 2
            });
        }

        // Spawn Gold Balloons floating upwards
        for (let i = 0; i < 10; i++) {
            this.balloons.push({
                x: Math.random() * this.canvas.width,
                y: this.canvas.height + Math.random() * 100,
                radius: Math.random() * 20 + 25,
                speedY: -(Math.random() * 2 + 1.5),
                drift: Math.random() * 1 - 0.5
            });
        }

        // Spawn extra falling caps
        for (let i = 0; i < 5; i++) {
            this.fallingCaps.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * -200,
                size: Math.random() * 40 + 40,
                speedY: Math.random() * 3 + 2,
                rotation: Math.random() * 40 - 20
            });
        }
    }

    renderLoop(results) {
        // Synchronize display scaling
        if (this.canvas.width !== this.video.videoWidth) {
            this.canvas.width = this.video.videoWidth;
            this.canvas.height = this.video.videoHeight;
        }

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw the background camera frame
        this.ctx.drawImage(results.image, 0, 0, this.canvas.width, this.canvas.height);

        // Process asset augmentation if coordinates are visible
        if (this.currentLandmarks) {
            this.drawGarments();
        }

        // Handle structural particle pipelines
        if (this.state >= GAME_STATES.DANCE) {
            this.updateAndRenderParticles();
        }
    }

    drawGarments() {
        const lm = this.currentLandmarks;

        // Scaling reference calculations
        const shoulderWidth = Math.abs(lm[11].x - lm[12].x) * this.canvas.width;
        const headWidth = Math.abs(lm[7].x - lm[8].x) * this.canvas.width * 2.5;

        // 1. GOWN AUGMENTATION (Tied to shoulders, scaled to chest dimensions)
        if (this.state >= GAME_STATES.CLAP_2) {
            const midShoulderX = ((lm[11].x + lm[12].x) / 2) * this.canvas.width;
            const midShoulderY = ((lm[11].y + lm[12].y) / 2) * this.canvas.height;
            const gownWidth = shoulderWidth * 2.2;
            const gownHeight = gownWidth * (this.assets.gown.height / this.assets.gown.width);

            this.ctx.drawImage(
                this.assets.gown,
                midShoulderX - gownWidth / 2,
                midShoulderY - (gownHeight * 0.1), 
                gownWidth,
                gownHeight
            );
        }

        // 2. CAP AUGMENTATION (Auto-fitted over head points)
        if (this.state >= GAME_STATES.CLAP_3) {
            const noseX = lm[0].x * this.canvas.width;
            const noseY = lm[0].y * this.canvas.height;
            const capWidth = headWidth * 1.6;
            const capHeight = capWidth * (this.assets.cap.height / this.assets.cap.width);
            
            // Handle drop animation interpolation safely
            const targetCapY = noseY - (capHeight * 0.95);
            if (this.capDropY < targetCapY) {
                this.capDropY += (targetCapY - this.capDropY) * 0.2; // Smooth snap
            } else {
                this.capDropY = targetCapY;
            }

            this.ctx.drawImage(
                this.assets.cap,
                noseX - capWidth / 2,
                this.capDropY,
                capWidth,
                capHeight
            );
        }

        // 3. DEGREE AUGMENTATION (Dynamically tracks the user's primary wrist coordinate)
        if (this.state >= GAME_STATES.DANCE) {
            const rightWristX = lm[16].x * this.canvas.width;
            const rightWristY = lm[16].y * this.canvas.height;
            const degreeWidth = shoulderWidth * 0.8;
            const degreeHeight = degreeWidth * (this.assets.degree.height / this.assets.degree.width);

            this.ctx.drawImage(
                this.assets.degree,
                rightWristX - degreeWidth / 2,
                rightWristY - degreeHeight / 2,
                degreeWidth,
                degreeHeight
            );
        }
    }

    updateAndRenderParticles() {
        // Confetti Loop Execution
        this.particles.forEach((p, idx) => {
            p.y += p.speedY;
            p.x += p.speedX;
            p.rotation += p.rotSpeed;

            this.ctx.save();
            this.ctx.translate(p.x, p.y);
            this.ctx.rotate((p.rotation * Math.PI) / 180);
            this.ctx.fillStyle = p.color;
            this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            this.ctx.restore();

            if (p.y > this.canvas.height) this.particles[idx].y = -10;
        });

        // Balloon Lift Execution
        this.balloons.forEach((b, idx) => {
            b.y += b.speedY;
            b.x += b.drift;

            this.ctx.beginPath();
            this.ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(212, 175, 55, 0.85)';
            this.ctx.fill();
            
            // Balloon String Execution
            this.ctx.beginPath();
            this.ctx.moveTo(b.x, b.y + b.radius);
            this.ctx.lineTo(b.x, b.y + b.radius + 30);
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();

            if (b.y < -b.radius * 2) this.balloons[idx].y = this.canvas.height + 50;
        });

        // Party Caps execution loops
        this.fallingCaps.forEach((c, idx) => {
            c.y += c.speedY;
            
            this.ctx.save();
            this.ctx.translate(c.x, c.y);
            this.ctx.rotate((c.rotation * Math.PI) / 180);
            this.ctx.drawImage(this.assets.cap, -c.size / 2, -c.size / 2, c.size, c.size * 0.6);
            this.ctx.restore();

            if (c.y > this.canvas.height + c.size) this.fallingCaps[idx].y = -c.size;
        });
    }

    setupModalEvents() {
        const modal = document.getElementById('polaroid-modal');
        const closeBtn = document.getElementById('close-modal');
        const saveBtn = document.getElementById('save-btn');
        const pCanvas = document.getElementById('polaroid-canvas');
        const pCtx = pCanvas.getContext('2d');

        this.captureBtn.addEventListener('click', () => {
            modal.classList.remove('hidden');
            
            // Map aspect ratio for structural snapshot framing
            pCanvas.width = 600;
            pCanvas.height = 600;

            // Compute centered clipping bounds out of the running wide 16:9 engine canvas
            const srcSize = Math.min(this.canvas.width, this.canvas.height);
            const srcX = (this.canvas.width - srcSize) / 2;
            const srcY = (this.canvas.height - srcSize) / 2;

            // Draw captured video framework onto the Polaroid frame square box
            pCtx.drawImage(this.canvas, srcX, srcY, srcSize, srcSize, 0, 0, pCanvas.width, pCanvas.height);
        });

        closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

        saveBtn.addEventListener('click', () => {
            // Target the output wrapper context container to render the whole Polaroid frame as a single combined file download
            const finalExportCanvas = document.createElement('canvas');
            const feCtx = finalExportCanvas.getContext('2d');
            
            finalExportCanvas.width = 640;
            finalExportCanvas.height = 780;

            // Fill out solid white backing background
            feCtx.fillStyle = '#ffffff';
            feCtx.fillRect(0, 0, finalExportCanvas.width, finalExportCanvas.height);

            // Draw snapshot frame centered cleanly inside wrapper boundaries
            feCtx.drawImage(pCanvas, 20, 20, 600, 600);

            // Print the customized signature text
            feCtx.fillStyle = '#2b2b2b';
            feCtx.font = 'bold 46px Courier New';
            feCtx.textAlign = 'center';
            feCtx.fillText('graduATE', finalExportCanvas.width / 2, 715);

            // Direct data string execution triggers immediate local download
            const imageURL = finalExportCanvas.toDataURL('image/jpeg', 0.95);
            const dlLink = document.createElement('a');
            dlLink.download = 'graduation-graduATE.jpg';
            dlLink.href = imageURL;
            dlLink.click();
        });
    }
}

// Global initialization entry point hook
window.addEventListener('DOMContentLoaded', () => {
    new GameEngine();
});
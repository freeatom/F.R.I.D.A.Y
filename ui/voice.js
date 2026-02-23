// ============================================================
// FRIDAY AI – Voice Engine
// Web Speech API: Speech-to-Text + Text-to-Speech
// ============================================================

class VoiceEngine {
    constructor() {
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.isListening = false;
        this.isSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
        this.onResult = null;
        this.onStatusChange = null;

        if (this.isSupported) {
            this._initRecognition();
        }
    }

    _initRecognition() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SR();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        let finalTranscript = '';

        this.recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript + ' ';
                    if (this.onResult) {
                        this.onResult(finalTranscript.trim(), true);
                        finalTranscript = '';
                    }
                } else {
                    interim += transcript;
                }
            }
            if (interim && this.onResult) {
                this.onResult(interim, false);
            }
        };

        this.recognition.onend = () => {
            if (this.isListening) {
                // Restart if still in listening mode (auto-restart)
                try { this.recognition.start(); } catch (e) { /* ignore */ }
            } else {
                this._setStatus(false);
            }
        };

        this.recognition.onerror = (event) => {
            if (event.error === 'not-allowed') {
                this.isListening = false;
                this._setStatus(false);
            }
            // For other errors, the onend handler will restart
        };
    }

    startListening() {
        if (!this.isSupported || this.isListening) return false;
        try {
            this.recognition.start();
            this.isListening = true;
            this._setStatus(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    stopListening() {
        if (!this.isListening) return;
        this.isListening = false;
        try { this.recognition.stop(); } catch (e) { /* ignore */ }
        this._setStatus(false);
    }

    toggleListening() {
        if (this.isListening) {
            this.stopListening();
        } else {
            this.startListening();
        }
        return this.isListening;
    }

    speak(text) {
        if (!this.synthesis) return;
        // Cancel any current speech
        this.synthesis.cancel();

        // Strip markdown for cleaner speech
        const clean = text
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]+`/g, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/#{1,6}\s/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[_~>]/g, '')
            .trim();

        if (!clean) return;

        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.rate = 1.05;
        utterance.pitch = 1.0;
        utterance.volume = 0.9;

        // Try to use a natural-sounding voice
        const voices = this.synthesis.getVoices();
        const preferred = voices.find(v =>
            v.name.includes('Zira') || v.name.includes('David') ||
            v.name.includes('Natural') || v.name.includes('Neural')
        ) || voices.find(v => v.lang.startsWith('en'));

        if (preferred) utterance.voice = preferred;

        this.synthesis.speak(utterance);
    }

    stopSpeaking() {
        if (this.synthesis) this.synthesis.cancel();
    }

    _setStatus(listening) {
        if (this.onStatusChange) {
            this.onStatusChange(listening);
        }
    }
}

window.voiceEngine = new VoiceEngine();

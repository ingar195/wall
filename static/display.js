(function () {
    const deviceId = document.body.dataset.deviceId;
    if (!deviceId) {
        return;
    }

    let socket;
    let reconnectDelay = 1000;
    let disconnectSince = null;
    let shiftStepIndex = 0;
    const shiftSteps = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 0, y: 20 },
        { x: 20, y: 20 },
    ];

    function schedulePixelShift() {
        const shiftTarget = document.querySelector(".display-grid") || document.body;
        // Reserve a 20px safe margin so shifting never pushes content off-screen.
        if (shiftTarget.classList && shiftTarget.classList.contains("display-grid")) {
            shiftTarget.style.width = "calc(100vw - 40px)";
            shiftTarget.style.height = "calc(100vh - 40px)";
            shiftTarget.style.margin = "20px";
        }
        shiftTarget.style.transition = "transform 220ms ease";
        setInterval(() => {
            shiftStepIndex = (shiftStepIndex + 1) % shiftSteps.length;
            const { x, y } = shiftSteps[shiftStepIndex];
            shiftTarget.style.transform = `translate(${x}px, ${y}px)`;
        }, 30 * 1000);
    }

    function connect() {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${protocol}://${window.location.host}/ws/device/${deviceId}`);

        socket.addEventListener("open", () => {
            reconnectDelay = 1000;
            disconnectSince = null;
        });

        socket.addEventListener("message", (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.action === "refresh" || payload.action === "new_layout") {
                    window.location.reload();
                }
            } catch (_) {
            }
        });

        socket.addEventListener("close", () => {
            if (!disconnectSince) {
                disconnectSince = Date.now();
            }
            if (Date.now() - disconnectSince > 5 * 60 * 1000) {
                window.location.reload();
                return;
            }
            window.setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        });
    }

    function startPingLoop() {
        setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "ping" }));
            }
        }, 30000);
    }

    schedulePixelShift();
    startPingLoop();
    connect();
})();
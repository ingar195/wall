(function () {
    const deviceId = document.body.dataset.deviceId;
    if (!deviceId) {
        return;
    }

    let socket;
    let reconnectDelay = 1000;
    let disconnectSince = null;

    function schedulePixelShift() {
        setInterval(() => {
            const x = Math.floor(Math.random() * 11) - 5;
            const y = Math.floor(Math.random() * 11) - 5;
            document.body.style.transform = `translate(${x}px, ${y}px)`;
        }, 15 * 60 * 1000);
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
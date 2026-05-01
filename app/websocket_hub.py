from __future__ import annotations

import asyncio

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, device_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.setdefault(device_id, set()).add(websocket)

    async def disconnect(self, device_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            device_connections = self._connections.get(device_id)
            if not device_connections:
                return
            device_connections.discard(websocket)
            if not device_connections:
                self._connections.pop(device_id, None)

    async def send(self, device_id: str, payload: dict) -> bool:
        async with self._lock:
            sockets = list(self._connections.get(device_id, set()))
        delivered = False
        for socket in sockets:
            try:
                await socket.send_json(payload)
                delivered = True
            except Exception:
                await self.disconnect(device_id, socket)
        return delivered


manager = ConnectionManager()
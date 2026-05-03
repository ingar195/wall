(function () {
    const buttons = document.querySelectorAll(".tab-btn");
    const panels = document.querySelectorAll(".tab-panel");
    if (buttons.length && panels.length) {
        function activate(tab) {
            buttons.forEach((button) => {
                const active = button.dataset.tab === tab;
                button.classList.toggle("active", active);
                button.setAttribute("aria-selected", String(active));
            });
            panels.forEach((panel) => panel.classList.toggle("hidden", panel.id !== "tab-" + tab));
            try {
                sessionStorage.setItem("adminTab", tab);
            } catch (_) {}
        }

        buttons.forEach((button) => {
            button.addEventListener("click", function () {
                activate(button.dataset.tab);
            });
        });

        try {
            const savedTab = sessionStorage.getItem("adminTab");
            if (savedTab) {
                activate(savedTab);
            }
        } catch (_) {}
    }
    function defaultLayout() {
        return {
            columns: 1,
            rows: 1,
            zones: [{ id: "zone-1", name: "Zone 1", x: 0, y: 0, w: 1, h: 1 }],
        };
    }

    function cloneLayout(layout) {
        return {
            columns: layout.columns,
            rows: layout.rows,
            zones: layout.zones.map((zone) => ({ ...zone })),
        };
    }

    function normalizeLayout(rawValue) {
        if (!String(rawValue || "").trim()) {
            return defaultLayout();
        }

        try {
            const parsed = JSON.parse(String(rawValue));
            if (!parsed || !Array.isArray(parsed.zones) || !parsed.zones.length) {
                return defaultLayout();
            }

            return {
                columns: Number(parsed.columns) || 1,
                rows: Number(parsed.rows) || 1,
                zones: parsed.zones.map((zone, index) => ({
                    id: String(zone.id || `zone-${index + 1}`),
                    name: String(zone.name || `Zone ${index + 1}`),
                    x: Number(zone.x) || 0,
                    y: Number(zone.y) || 0,
                    w: Number(zone.w) || 1,
                    h: Number(zone.h) || 1,
                })),
            };
        } catch (_) {
            return defaultLayout();
        }
    }

    function sortZones(zones) {
        return zones.slice().sort((left, right) => left.y - right.y || left.x - right.x || left.name.localeCompare(right.name));
    }

    function gcd(a, b) {
        let x = Math.abs(Number(a) || 0);
        let y = Math.abs(Number(b) || 0);
        while (y !== 0) {
            const t = y;
            y = x % y;
            x = t;
        }
        return x || 1;
    }

    function nextZoneName(layout) {
        return `Zone ${layout.zones.length + 1}`;
    }

    function nextZoneId(layout) {
        return `zone-${layout.zones.length + 1}`;
    }

    function splitZone(layout, selectedZoneId, direction) {
        const target = layout.zones.find((zone) => zone.id === selectedZoneId);
        if (!target) {
            return null;
        }

        if (direction === "vertical") {
            layout.columns *= 2;
            layout.zones.forEach((zone) => {
                zone.x *= 2;
                zone.w *= 2;
            });
            const sibling = {
                id: nextZoneId(layout),
                name: nextZoneName(layout),
                x: target.x + target.w / 2,
                y: target.y,
                w: target.w / 2,
                h: target.h,
            };
            target.w /= 2;
            layout.zones.push(sibling);
            return sibling.id;
        }

        layout.rows *= 2;
        layout.zones.forEach((zone) => {
            zone.y *= 2;
            zone.h *= 2;
        });
        const sibling = {
            id: nextZoneId(layout),
            name: nextZoneName(layout),
            x: target.x,
            y: target.y + target.h / 2,
            w: target.w,
            h: target.h / 2,
        };
        target.h /= 2;
        layout.zones.push(sibling);
        return sibling.id;
    }

    function normalizeGrid(layout) {
        while (layout.columns > 1) {
            const columnDivisor = [layout.columns]
                .concat(layout.zones.flatMap((zone) => [zone.x, zone.w]))
                .reduce((acc, value) => gcd(acc, value), 0);
            if (columnDivisor <= 1) {
                break;
            }
            layout.columns /= columnDivisor;
            layout.zones.forEach((zone) => {
                zone.x /= columnDivisor;
                zone.w /= columnDivisor;
            });
        }

        while (layout.rows > 1) {
            const rowDivisor = [layout.rows]
                .concat(layout.zones.flatMap((zone) => [zone.y, zone.h]))
                .reduce((acc, value) => gcd(acc, value), 0);
            if (rowDivisor <= 1) {
                break;
            }
            layout.rows /= rowDivisor;
            layout.zones.forEach((zone) => {
                zone.y /= rowDivisor;
                zone.h /= rowDivisor;
            });
        }
    }

    function removeSplit(layout, selectedZoneId) {
        if (layout.zones.length <= 1) {
            return null;
        }

        const target = layout.zones.find((zone) => zone.id === selectedZoneId);
        if (!target) {
            return null;
        }

        const candidates = layout.zones.filter((zone) => zone.id !== selectedZoneId);
        const sibling = candidates.find((zone) => (
            zone.y === target.y &&
            zone.h === target.h &&
            (zone.x + zone.w === target.x || target.x + target.w === zone.x)
        )) || candidates.find((zone) => (
            zone.x === target.x &&
            zone.w === target.w &&
            (zone.y + zone.h === target.y || target.y + target.h === zone.y)
        ));

        if (!sibling) {
            return null;
        }

        if (sibling.y === target.y && sibling.h === target.h) {
            sibling.x = Math.min(sibling.x, target.x);
            sibling.w += target.w;
        } else {
            sibling.y = Math.min(sibling.y, target.y);
            sibling.h += target.h;
        }

        layout.zones = layout.zones.filter((zone) => zone.id !== selectedZoneId);
        normalizeGrid(layout);
        return sibling.id;
    }

    function getResizeHandles(layout, selectedZoneId) {
        const selectedZone = layout.zones.find((zone) => zone.id === selectedZoneId);
        if (!selectedZone) {
            return [];
        }

        return layout.zones.filter((zone) => zone.id !== selectedZoneId).flatMap((zone) => {
            if (zone.y === selectedZone.y && zone.h === selectedZone.h) {
                if (zone.x + zone.w === selectedZone.x && (zone.w > 1 || selectedZone.w > 1)) {
                    return [{ direction: "west", neighborId: zone.id }];
                }
                if (selectedZone.x + selectedZone.w === zone.x && (zone.w > 1 || selectedZone.w > 1)) {
                    return [{ direction: "east", neighborId: zone.id }];
                }
            }

            if (zone.x === selectedZone.x && zone.w === selectedZone.w) {
                if (zone.y + zone.h === selectedZone.y && (zone.h > 1 || selectedZone.h > 1)) {
                    return [{ direction: "north", neighborId: zone.id }];
                }
                if (selectedZone.y + selectedZone.h === zone.y && (zone.h > 1 || selectedZone.h > 1)) {
                    return [{ direction: "south", neighborId: zone.id }];
                }
            }

            return [];
        });
    }

    function resizeSelectedZone(layout, selectedZoneId, direction, neighborId) {
        const selectedZone = layout.zones.find((zone) => zone.id === selectedZoneId);
        const neighbor = layout.zones.find((zone) => zone.id === neighborId);
        if (!selectedZone || !neighbor) {
            return false;
        }

        if (direction === "east") {
            if (neighbor.w > 1) {
                selectedZone.w += 1;
                neighbor.x += 1;
                neighbor.w -= 1;
                return true;
            }
            if (selectedZone.w > 1) {
                selectedZone.w -= 1;
                neighbor.x -= 1;
                neighbor.w += 1;
                return true;
            }
        }

        if (direction === "west") {
            if (neighbor.w > 1) {
                selectedZone.x -= 1;
                selectedZone.w += 1;
                neighbor.w -= 1;
                return true;
            }
            if (selectedZone.w > 1) {
                selectedZone.x += 1;
                selectedZone.w -= 1;
                neighbor.w += 1;
                return true;
            }
        }

        if (direction === "south") {
            if (neighbor.h > 1) {
                selectedZone.h += 1;
                neighbor.y += 1;
                neighbor.h -= 1;
                return true;
            }
            if (selectedZone.h > 1) {
                selectedZone.h -= 1;
                neighbor.y -= 1;
                neighbor.h += 1;
                return true;
            }
        }

        if (direction === "north") {
            if (neighbor.h > 1) {
                selectedZone.y -= 1;
                selectedZone.h += 1;
                neighbor.h -= 1;
                return true;
            }
            if (selectedZone.h > 1) {
                selectedZone.y += 1;
                selectedZone.h -= 1;
                neighbor.h += 1;
                return true;
            }
        }

        return false;
    }

    function findContiguousBand(layout, selectedZoneId, axis) {
        const selectedZone = layout.zones.find((zone) => zone.id === selectedZoneId);
        if (!selectedZone) {
            return [];
        }

        const sameBandZones = layout.zones.filter((zone) => {
            if (axis === "horizontal") {
                return zone.y === selectedZone.y && zone.h === selectedZone.h;
            }
            return zone.x === selectedZone.x && zone.w === selectedZone.w;
        });

        const sorted = sameBandZones.slice().sort((left, right) => {
            if (axis === "horizontal") {
                return left.x - right.x;
            }
            return left.y - right.y;
        });

        const selectedIndex = sorted.findIndex((zone) => zone.id === selectedZoneId);
        if (selectedIndex === -1) {
            return [];
        }

        let start = selectedIndex;
        let end = selectedIndex;

        while (start > 0) {
            const previous = sorted[start - 1];
            const current = sorted[start];
            const touching = axis === "horizontal"
                ? previous.x + previous.w === current.x
                : previous.y + previous.h === current.y;
            if (!touching) {
                break;
            }
            start -= 1;
        }

        while (end < sorted.length - 1) {
            const current = sorted[end];
            const next = sorted[end + 1];
            const touching = axis === "horizontal"
                ? current.x + current.w === next.x
                : current.y + current.h === next.y;
            if (!touching) {
                break;
            }
            end += 1;
        }

        return sorted.slice(start, end + 1);
    }

    function symmetrizeBand(layout, zones, axis) {
        if (zones.length <= 1) {
            return false;
        }

        const currentSizes = zones.map((zone) => axis === "horizontal" ? zone.w : zone.h);
        if (currentSizes.every((size) => size === currentSizes[0])) {
            return false;
        }

        const totalSize = currentSizes.reduce((sum, size) => sum + size, 0);
        const segmentCount = zones.length;
        const scaleFactor = Number.isInteger(totalSize / segmentCount)
            ? 1
            : segmentCount / gcd(totalSize, segmentCount);

        if (axis === "horizontal") {
            if (scaleFactor > 1) {
                layout.columns *= scaleFactor;
                layout.zones.forEach((zone) => {
                    zone.x *= scaleFactor;
                    zone.w *= scaleFactor;
                });
            }

            const scaledZones = zones
                .map((zone) => layout.zones.find((candidate) => candidate.id === zone.id))
                .filter(Boolean)
                .sort((left, right) => left.x - right.x);
            if (!scaledZones.length) {
                return false;
            }
            const totalWidth = scaledZones.reduce((sum, zone) => sum + zone.w, 0);
            const equalWidth = Math.round(totalWidth / scaledZones.length);

            let currentX = scaledZones[0].x;
            scaledZones.forEach((zone) => {
                zone.x = currentX;
                zone.w = equalWidth;
                currentX += equalWidth;
            });
            normalizeGrid(layout);
            return true;
        }

        if (scaleFactor > 1) {
            layout.rows *= scaleFactor;
            layout.zones.forEach((zone) => {
                zone.y *= scaleFactor;
                zone.h *= scaleFactor;
            });
        }

        const scaledZones = zones
            .map((zone) => layout.zones.find((candidate) => candidate.id === zone.id))
            .filter(Boolean)
            .sort((left, right) => left.y - right.y);
        if (!scaledZones.length) {
            return false;
        }
        const totalHeight = scaledZones.reduce((sum, zone) => sum + zone.h, 0);
        const equalHeight = Math.round(totalHeight / scaledZones.length);

        let currentY = scaledZones[0].y;
        scaledZones.forEach((zone) => {
            zone.y = currentY;
            zone.h = equalHeight;
            currentY += equalHeight;
        });
        normalizeGrid(layout);
        return true;
    }

    function makeSelectedZoneSymmetric(layout, selectedZoneId) {
        const horizontalBand = findContiguousBand(layout, selectedZoneId, "horizontal");
        if (horizontalBand.length > 1 && symmetrizeBand(layout, horizontalBand, "horizontal")) {
            return true;
        }

        const verticalBand = findContiguousBand(layout, selectedZoneId, "vertical");
        return verticalBand.length > 1 && symmetrizeBand(layout, verticalBand, "vertical");
    }

    function initializeLayoutBuilders() {
        document.querySelectorAll("[data-layout-builder]").forEach((builder) => {
            const jsonField = builder.querySelector("[data-layout-json]");
            const preview = builder.querySelector("[data-layout-preview]");
            const status = builder.querySelector("[data-layout-status]");
            const resetButton = builder.querySelector("[data-layout-reset]");
            const splitButtons = builder.querySelectorAll("[data-layout-split]");
            const symmetricButton = builder.querySelector("[data-layout-symmetric]");
            const removeButton = builder.querySelector("[data-layout-remove]");
            const initialLayout = normalizeLayout(jsonField.value);
            const state = {
                initialLayout: cloneLayout(initialLayout),
                layout: cloneLayout(initialLayout),
                selectedZoneId: initialLayout.zones[0].id,
            };

            function syncField() {
                jsonField.value = JSON.stringify(
                    {
                        columns: state.layout.columns,
                        rows: state.layout.rows,
                        zones: sortZones(state.layout.zones),
                    },
                    null,
                    2
                );
            }

            function render() {
                syncField();
                preview.innerHTML = "";
                preview.style.setProperty("--layout-columns", String(state.layout.columns));
                preview.style.setProperty("--layout-rows", String(state.layout.rows));

                sortZones(state.layout.zones).forEach((zone) => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "layout-zone-tile" + (zone.id === state.selectedZoneId ? " selected" : "");
                    button.style.gridColumn = `${zone.x + 1} / span ${zone.w}`;
                    button.style.gridRow = `${zone.y + 1} / span ${zone.h}`;
                    button.dataset.zoneId = zone.id;
                    button.innerHTML = `<strong>${zone.name}</strong>`;
                    button.addEventListener("click", function () {
                        state.selectedZoneId = zone.id;
                        render();
                    });
                    preview.appendChild(button);
                });

                const selectedZone = state.layout.zones.find((zone) => zone.id === state.selectedZoneId) || state.layout.zones[0];
                state.selectedZoneId = selectedZone.id;
                const resizeHandles = getResizeHandles(state.layout, state.selectedZoneId);
                resizeHandles.forEach((handle) => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = `layout-resize-handle ${handle.direction}`;
                    button.textContent = handle.direction === "east" ? "→" : handle.direction === "west" ? "←" : handle.direction === "south" ? "↓" : "↑";
                    button.title = `Resize ${handle.direction}`;
                    if (handle.direction === "east") {
                        button.style.left = `${((selectedZone.x + selectedZone.w) / state.layout.columns) * 100}%`;
                        button.style.top = `${((selectedZone.y + selectedZone.h / 2) / state.layout.rows) * 100}%`;
                    } else if (handle.direction === "west") {
                        button.style.left = `${(selectedZone.x / state.layout.columns) * 100}%`;
                        button.style.top = `${((selectedZone.y + selectedZone.h / 2) / state.layout.rows) * 100}%`;
                    } else if (handle.direction === "south") {
                        button.style.left = `${((selectedZone.x + selectedZone.w / 2) / state.layout.columns) * 100}%`;
                        button.style.top = `${((selectedZone.y + selectedZone.h) / state.layout.rows) * 100}%`;
                    } else {
                        button.style.left = `${((selectedZone.x + selectedZone.w / 2) / state.layout.columns) * 100}%`;
                        button.style.top = `${(selectedZone.y / state.layout.rows) * 100}%`;
                    }
                    button.addEventListener("click", function () {
                        if (resizeSelectedZone(state.layout, state.selectedZoneId, handle.direction, handle.neighborId)) {
                            render();
                        }
                    });
                    preview.appendChild(button);
                });

                status.textContent = resizeHandles.length
                    ? `Selected: ${selectedZone.name} - use edge handles to resize.`
                    : `Selected: ${selectedZone.name}`;
                if (removeButton) {
                    removeButton.disabled = state.layout.zones.length <= 1;
                }
                if (symmetricButton) {
                    const canSymmetrize = findContiguousBand(state.layout, state.selectedZoneId, "horizontal").length > 1 ||
                        findContiguousBand(state.layout, state.selectedZoneId, "vertical").length > 1;
                    symmetricButton.disabled = !canSymmetrize;
                }
            }

            splitButtons.forEach((button) => {
                button.addEventListener("click", function () {
                    const nextSelectedZoneId = splitZone(state.layout, state.selectedZoneId, button.dataset.layoutSplit);
                    if (nextSelectedZoneId) {
                        state.selectedZoneId = nextSelectedZoneId;
                        render();
                    }
                });
            });

            resetButton.addEventListener("click", function () {
                state.layout = cloneLayout(state.initialLayout);
                state.selectedZoneId = state.layout.zones[0].id;
                render();
            });

            if (removeButton) {
                removeButton.addEventListener("click", function () {
                    const nextSelectedZoneId = removeSplit(state.layout, state.selectedZoneId);
                    if (nextSelectedZoneId) {
                        state.selectedZoneId = nextSelectedZoneId;
                        render();
                    }
                });
            }

            if (symmetricButton) {
                symmetricButton.addEventListener("click", function () {
                    if (makeSelectedZoneSymmetric(state.layout, state.selectedZoneId)) {
                        render();
                    }
                });
            }

            render();
        });
    }

    initializeLayoutBuilders();
})();

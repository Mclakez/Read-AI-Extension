(function () {
  let overlay = null;
  let selectionBox = null;
  let startX, startY;
  let isSelecting = false;
  let resolveSelection = null;
  let keyHandler = null;

  window.startBoxSelection = function () {
    return new Promise(function (resolve) {
      resolveSelection = resolve;
      createOverlay();
    });
  };

  window.cancelImageSelect = function () {
    cleanup();
    removeOverlay();
    if (resolveSelection) {
      resolveSelection(null);
      resolveSelection = null;
    }
  };

  function createOverlay() {
    overlay = document.createElement("div");
    overlay.id = "readai-overlay";
    document.body.appendChild(overlay);

    selectionBox = document.createElement("div");
    selectionBox.id = "readai-selection-box";
    overlay.appendChild(selectionBox);

    overlay.addEventListener("mousedown", onMouseDown);

    keyHandler = function (e) {
      if (e.key === "Escape") {
        window.cancelImageSelect();
      }
    };
    document.addEventListener("keydown", keyHandler);
  }

  function onMouseDown(e) {
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;

    selectionBox.style.display = "block";
    selectionBox.style.left = startX + "px";
    selectionBox.style.top = startY + "px";
    selectionBox.style.width = "0px";
    selectionBox.style.height = "0px";

    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mouseup", onMouseUp);
    overlay.addEventListener("mouseleave", onMouseUp);
  }

  function onMouseMove(e) {
    if (!isSelecting) return;
    var x = Math.min(startX, e.clientX);
    var y = Math.min(startY, e.clientY);
    var w = Math.abs(e.clientX - startX);
    var h = Math.abs(e.clientY - startY);
    selectionBox.style.left = x + "px";
    selectionBox.style.top = y + "px";
    selectionBox.style.width = w + "px";
    selectionBox.style.height = h + "px";
  }

  function onMouseUp(e) {
    if (!isSelecting) return;
    isSelecting = false;

    overlay.removeEventListener("mousemove", onMouseMove);
    overlay.removeEventListener("mouseup", onMouseUp);
    overlay.removeEventListener("mouseleave", onMouseUp);

    var x = Math.min(startX, e.clientX);
    var y = Math.min(startY, e.clientY);
    var w = Math.abs(e.clientX - startX);
    var h = Math.abs(e.clientY - startY);

    removeOverlay();

    if (w < 5 && h < 5) {
      if (resolveSelection) {
        resolveSelection(null);
        resolveSelection = null;
      }
      return;
    }

    if (resolveSelection) {
      var rect = {
        x: x, y: y, width: w, height: h,
        left: x, top: y, bottom: y + h, right: x + w,
        devicePixelRatio: window.devicePixelRatio || 1
      };
      resolveSelection(rect);
      resolveSelection = null;
    }
  }

  function removeOverlay() {
    if (overlay) {
      overlay.remove();
      overlay = null;
      selectionBox = null;
    }
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
  }

  function cleanup() {
    if (overlay) {
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("mousemove", onMouseMove);
      overlay.removeEventListener("mouseup", onMouseUp);
      overlay.removeEventListener("mouseleave", onMouseUp);
    }
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
  }
})();

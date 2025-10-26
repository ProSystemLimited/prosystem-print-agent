const express = require('express');
const bodyParser = require('body-parser');
const { BrowserWindow } = require('electron');
const WebSocket = require('ws');
const cors = require('cors');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const printer = require('@thesusheer/electron-printer');
const net = require('net');

// Track active print jobs to prevent duplicates
const activePrintJobs = new Map();

/**
 * Formats a date object or a valid date string into a DD/MM/YYYY string.
 *
 * @param {Date | string | null | undefined} date The date object or string to format.
 * @returns {string} A string representing the date in DD/MM/YYYY format, or an empty string if the input is falsy.
 * @example
 * // returns "21/08/2025"
 * formatDate('2025-08-21T05:57:15');
 */
const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
};

/**
 * Formats a date object or a valid date string into a 12-hour time string with AM/PM.
 *
 * @param {Date | string | null | undefined} time The date object or string to format for its time.
 * @returns {string} A string representing the time (e.g., "5:57 AM"), or an empty string if the input is falsy.
 * @example
 * // returns "5:57 AM"
 * formatTime('2025-08-21T05:57:15');
 *
 * @example
 * // returns "1:30 PM"
 * formatTime('2025-08-21T13:30:00');
 */
const formatTime = (time) => {
  if (!time) return '';
  const d = new Date(time);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12; // Convert to 12-hour format, handling midnight
  return `${hours}:${minutes} ${period}`;
};

function CommaFormatted(amount) {
  var delimiter = ","; // replace comma if desired
  var a = amount.split('.', 2);
  var d = a[1] || '';
  var i = parseInt(a[0]);
  if (isNaN(i)) { return ''; }
  var minus = '';
  if (i < 0) { minus = '-'; }
  i = Math.abs(i);
  var n = new String(i);
  var a = [];
  while (n.length > 3) {
    var nn = n.substr(n.length - 3);
    a.unshift(nn);
    n = n.substr(0, n.length - 3);
  }
  if (n.length > 0) { a.unshift(n); }
  n = a.join(delimiter);
  if (d.length < 1) { amount = n; }
  else { amount = n + '.' + d; }

  // Remove .00 at the end of values
  amount = amount.replace(/\.00$/, '');

  amount = minus + amount;
  return amount;
}

function CurrencyFormatted(amount, currency = 'BDT') {
  var i = parseFloat(amount);
  if (currency !== 'BDT') {
    i = Math.round(i);
  }
  if (isNaN(i)) { i = 0.00; }
  var minus = '';
  if (i < 0) { minus = '-'; }
  i = Math.abs(i);
  i = parseInt((i + .005) * 100);
  i = i / 100;
  var s = new String(i);

  // Remove .00 at the end of values
  if (s.indexOf('.') >= 0) {
    s = s.replace(/\.00$/, '');
  }

  s = minus + s;
  return s;
}

async function validateAndConvertImage(base64Data) {
  const sharp = require('sharp'); // npm install sharp

  try {
    // Remove data URI prefix if present
    const base64String = base64Data.includes(',')
      ? base64Data.split(',')[1]
      : base64Data;

    const buffer = Buffer.from(base64String, 'base64');

    // Convert to PNG and resize for thermal printer (max width 200px)
    const processedBuffer = await sharp(buffer)
      .resize({ width: 200, fit: 'inside' })
      .png()
      .toBuffer();

    return processedBuffer;
  } catch (error) {
    console.error('Image validation failed:', error);
    return null;
  }
}

function buildThermalReceipt(printer, data, totals) {
  // Get character width from printer config
  const charWidth = printer.config.width;

  // Header - Organization
  printer.alignCenter();
  printer.setTextQuadArea(); // Make it even bigger - 2x width and 2x height
  printer.bold(true);
  printer.println(data.displayName || 'Organization');
  printer.bold(false);
  printer.setTextNormal();

  // BIN & VAT
  if (data.location?.binNumber || data.binNumber) {
    printer.println(`BIN: ${data.location?.binNumber || data.binNumber}`);
    if (data.location?.vatFormNumber || data.vatFormNumber) {
      printer.println(`Mushak - ${data.location.vatFormNumber || data.vatFormNumber}`);
    }
  }

  // Address - wrap to avoid breaking words mid-line
  if (data.location?.address) {
    const addressLines = wrapText(data.location.address, charWidth);
    addressLines.forEach(line => printer.println(line));
  }

  // Contact
  if (data.location?.phone || data.location?.email) {
    if (data.location?.phone) {
      printer.print(data.location.phone);
      if (data.location?.email) {
        printer.print(', ');
      }
    }
    if (data.location?.email) {
      printer.print(data.location.email);
    }
    printer.newLine();
  }

  if (data.customDomain) {
    printer.println(data.customDomain);
  }

  // Switch to left-aligned for rest of receipt
  printer.alignLeft();
  printer.drawLine();

  // Invoice Info - Manual spacing for full width
  printer.println(createTwoColumnLine(
    `INVOICE ${data.invoiceNumber}`,
    formatDate(data.createdAt),
    charWidth
  ));
  printer.println(createTwoColumnLine(
    '',
    formatTime(data.createdAt),
    charWidth
  ));

  // Customer
  if (data.customer) {
    printer.drawLine();
    printer.bold(true);
    printer.println('CUSTOMER');
    printer.bold(false);

    if (data.customer.name) printer.println(data.customer.name);
    if (data.customer.phone) printer.println(`Phone: ${data.customer.phone}`);
    if (data.customer.email) printer.println(`Email: ${data.customer.email}`);

    if (data.customer.addresses?.length > 0) {
      const addr = data.customer.addresses[0];
      const addrParts = [
        addr?.addressLine,
        addr?.area?.label,
        addr?.city?.label,
        addr?.zipcode,
        addr?.country
      ].filter(Boolean).join(', ');

      if (addrParts) {
        printer.println(`Address: ${addrParts}`);
      }
    }
  }

  // Items Header - Full width table
  printer.drawLine();
  printer.bold(true);
  printer.tableCustom([
    { text: "Sl", align: "LEFT", width: 0.08 },
    { text: "Item", align: "LEFT", width: 0.54 },
    { text: "Qty", align: "CENTER", width: 0.15 },
    { text: "Price", align: "RIGHT", width: 0.23 }
  ]);
  printer.bold(false);
  printer.drawLine();

  // Items - Full width for each item
  data.items.forEach((item, index) => {
    const itemName = [item.variantName, item.itemName].filter(Boolean).join(' - ');
    const serialNum = `${index + 1}.`;

    // Calculate max characters that fit in the item column (54% of width)
    const itemColumnWidth = Math.floor(charWidth * 0.54);

    // Wrap the item name to fit within the item column
    const wrappedLines = wrapText(itemName, itemColumnWidth);

    // Print first line with serial number, item name, qty, and price
    printer.tableCustom([
      { text: serialNum, align: "LEFT", width: 0.08 },
      { text: wrappedLines[0], align: "LEFT", width: 0.54 },
      { text: item.quantity.toString(), align: "CENTER", width: 0.15 },
      { text: CommaFormatted(CurrencyFormatted(item.unitPrice)), align: "RIGHT", width: 0.23 }
    ]);

    // Print remaining lines (if any) with empty serial/qty/price columns
    for (let i = 1; i < wrappedLines.length; i++) {
      printer.tableCustom([
        { text: "", align: "LEFT", width: 0.08 },
        { text: wrappedLines[i], align: "LEFT", width: 0.54 },
        { text: "", align: "CENTER", width: 0.15 },
        { text: "", align: "RIGHT", width: 0.23 }
      ]);
    }
  });

  // Summary Section - Manual spacing for full width
  printer.drawLine();
  printer.println(createTwoColumnLine(
    `Subtotal (${totals.totalQuantity})`,
    CommaFormatted(CurrencyFormatted(totals.subtotal)),
    charWidth
  ));

  // Charges - Manual spacing
  totals.charges.forEach(charge => {
    const inclusiveText = charge.applicationMethod === 'INCLUSIVE' ? ' (inc)' : '';
    printer.println(createTwoColumnLine(
      `${charge.chargeLabel}${inclusiveText}`,
      CommaFormatted(CurrencyFormatted(Math.abs(charge.calculatedValue))),
      charWidth
    ));
  });

  // Grand Total - Manual spacing
  printer.bold(true);
  printer.println(createTwoColumnLine(
    "TOTAL",
    `${CommaFormatted(CurrencyFormatted(totals.grandTotal))}`,
    charWidth
  ));
  printer.bold(false);

  // Payments - Manual spacing for full width
  if (totals.payments.length > 0) {
    printer.drawLine();
    totals.payments.forEach(payment => {
      printer.println(createTwoColumnLine(
        payment.method,
        CommaFormatted(CurrencyFormatted(payment.amount)),
        charWidth
      ));

      if (payment.createdAt) {
        const paymentDate = `${formatDate(payment.createdAt)}, ${formatTime(payment.createdAt)}`;
        printer.println(`  ${paymentDate}, ${payment.user || 'Admin'}`);
      }
    });

    printer.drawLine();

    if (totals.totalPaid > 0) {
      printer.bold(true);
      printer.println(createTwoColumnLine(
        "PAID",
        `${CommaFormatted(CurrencyFormatted(totals.totalPaid))}`,
        charWidth
      ));
      printer.bold(false);
    }

    if (totals.balanceDue > 0) {
      printer.bold(true);
      printer.println(createTwoColumnLine(
        "DUE",
        `${CommaFormatted(CurrencyFormatted(totals.balanceDue))}`,
        charWidth
      ));
      printer.bold(false);
    }
  }

  // Notes
  const visibleNotes = (data.notes || []).filter(n => n.visibleOnInvoice);
  if (visibleNotes.length > 0) {
    printer.newLine();
    printer.drawLine();
    printer.bold(true);
    printer.println('Notes:');
    printer.bold(false);

    visibleNotes.forEach(note => {
      printer.println(`- ${note.text}`);
      if (note.createdAt) {
        const noteDate = `${formatDate(note.createdAt)}, ${formatTime(note.createdAt)}`;
        printer.println(`  ${noteDate}, ${note.author?.name || 'System'}`);
      }
    });
  }

  // Footer
  printer.newLine();
  printer.alignCenter();
  printer.setTypeFontB();  // Switch to smaller font
  printer.println('Powered by ProSystem');
  printer.setTypeFontA();  // Reset to normal font

  // Cut paper
  printer.cut();
}


/**
 * Calculate optimal character width for thermal printer based on paper width
 * Uses real-world thermal printer specifications
 *
 * @param {number} widthMM - Paper width in millimeters
 * @returns {number} - Recommended character count per line
 */
function getOptimalCharacterWidth(widthMM) {
  // Standard thermal printer paper widths and their character counts
  // Based on Font A (12x24) at 203 DPI with 3mm margins
  const standardWidths = {
    58: 32,   // 58mm paper - Common for mobile printers
    76: 42,   // 76mm paper - Less common
    80: 48,   // 80mm paper - Most common for receipts
    82: 48,   // 82mm paper
    110: 64,  // 110mm paper - Wider receipts
  };

  // Find closest standard width
  const widths = Object.keys(standardWidths).map(Number);
  const closest = widths.reduce((prev, curr) => {
    return Math.abs(curr - widthMM) < Math.abs(prev - widthMM) ? curr : prev;
  });

  // If within 2mm of standard, use standard value
  if (Math.abs(closest - widthMM) <= 2) {
    return standardWidths[closest];
  }

  // Otherwise calculate dynamically
  // Formula: (printableWidthMM / 10) * 5.9 chars/cm for 203 DPI Font A
  const printableWidthMM = widthMM - 6; // 3mm margins on each side
  const printableWidthCM = printableWidthMM / 10;
  const charsPerCM = 5.9; // Standard for Font A at 203 DPI
  const calculatedChars = Math.floor(printableWidthCM * charsPerCM);

  // Return constrained value (thermal printers typically support 32-64 chars)
  return Math.max(32, Math.min(64, calculatedChars));
}

/**
 * Pad string to the right with spaces
 */
function padRight(str, length) {
  str = str.toString();
  if (str.length >= length) return str.substring(0, length);
  return str + ' '.repeat(length - str.length);
}

/**
 * Pad string to the left with spaces
 */
function padLeft(str, length) {
  str = str.toString();
  if (str.length >= length) return str.substring(0, length);
  return ' '.repeat(length - str.length) + str;
}

/**
 * Create a two-column layout with exact character positioning
 */
function createTwoColumnLine(leftText, rightText, totalWidth) {
  const leftStr = leftText.toString();
  const rightStr = rightText.toString();

  // Calculate spacing
  const spaceNeeded = totalWidth - leftStr.length - rightStr.length;

  if (spaceNeeded < 1) {
    // Truncate left text if too long
    const truncatedLeft = leftStr.substring(0, totalWidth - rightStr.length - 1);
    return truncatedLeft + ' ' + rightStr;
  }

  return leftStr + ' '.repeat(spaceNeeded) + rightStr;
}

/**
 * Wrap text to fit within a specific character width
 */
function wrapText(text, maxWidth) {
  if (text.length <= maxWidth) {
    return [text];
  }

  const lines = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }

    // Try to break at a space before maxWidth
    let breakPoint = maxWidth;
    const lastSpace = remaining.substring(0, maxWidth).lastIndexOf(' ');

    if (lastSpace > 0) {
      breakPoint = lastSpace;
    }

    lines.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return lines;
}

let wss;
let globalWebContents;

function startApi(webContents) {
  globalWebContents = webContents;
  const api = express();
  api.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
  api.use(bodyParser.json({ limit: '1mb' }));

  wss = new WebSocket.Server({ port: 21322 });
  wss.on('connection', async socket => {
    console.log('🔌 WebSocket client connected.');
    socket.isAlive = true;

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('close', () => console.log('❌ WebSocket client disconnected'));

    try {
      const rawPrinters = await globalWebContents.getPrintersAsync();
      const printers = formatPrinterList(rawPrinters);
      socket.send(JSON.stringify({ type: 'printer-status', printers }));
    } catch (e) {
      socket.send(JSON.stringify({ type: 'printer-status', printers: [] }));
    }
  });

  setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  api.get('/list-printers', async (_req, res) => {
    try {
      const rawPrinters = await webContents.getPrintersAsync();
      const printers = formatPrinterList(rawPrinters);
      res.json(printers);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list printers' });
    }
  });

  api.post('/print', async (req, res) => {
    let win = null;
    let jobKey = null;
    let callbackCalled = false;

    try {
      const { printer, html, widthMM, heightMM } = req.body;

      // Validate printer is available
      if (!printer || !printer.name) {
        return res.status(400).json({
          error: 'Invalid printer configuration',
          message: 'Printer information is missing or invalid'
        });
      }

      // Create a unique key for this print job
      jobKey = `${printer.name}-${Date.now()}`;

      // Check if there's already an active job for this printer
      if (activePrintJobs.has(printer.name)) {
        console.log(`Print job already in progress for printer: ${printer.name}`);
        return res.status(409).json({
          error: 'Print job already in progress',
          message: 'Please wait for the current print job to complete'
        });
      }

      // Mark this printer as busy
      activePrintJobs.set(printer.name, jobKey);

      win = new BrowserWindow({ show: false });

      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

      // Wrap the print callback in a Promise for better error handling
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!callbackCalled) {
            callbackCalled = true;
            reject(new Error('Print operation timed out after 30 seconds'));
          }
        }, 30000);

        win.webContents.print(
          {
            silent: true,
            deviceName: printer.name,
            margins: { marginType: 'none' },
            pageSize: {
              width: Math.round(widthMM * 1000),
              height: Math.round(heightMM * 1000)
            }
          },
          (success, failure) => {
            // Prevent multiple callback invocations
            if (callbackCalled) {
              console.warn('Print callback called multiple times, ignoring');
              return;
            }
            callbackCalled = true;
            clearTimeout(timeout);

            if (!success) {
              // Log the actual failure message to understand what's happening
              console.log('Print not successful. Success:', success, 'Failure:', failure);

              // Treat all print failures as "success" to avoid error toasts
              // The user will see the result in the system print dialog
              // Common scenarios: user cancelled, printer offline, etc.
              console.log('Print operation completed (may have been cancelled by user)');
              resolve();
            } else {
              console.log('✔️ job queued');
              resolve();
            }
          }
        );
      });

      // Clean up
      if (win && !win.isDestroyed()) {
        win.destroy();
      }

      // Remove from active jobs
      if (jobKey && activePrintJobs.get(printer.name) === jobKey) {
        activePrintJobs.delete(printer.name);
      }

      res.sendStatus(204);

    } catch (e) {
      console.error('Print API error:', e);

      // Clean up window
      if (win && !win.isDestroyed()) {
        try {
          win.destroy();
        } catch (destroyError) {
          console.error('Error destroying window:', destroyError);
        }
      }

      // Remove from active jobs
      if (jobKey && activePrintJobs.get(req.body.printer?.name) === jobKey) {
        activePrintJobs.delete(req.body.printer.name);
      }

      // Return a user-friendly error message
      const errorMessage = e.message || 'Unknown print error occurred';
      res.status(500).json({
        error: 'Print operation failed',
        message: errorMessage,
        details: 'Please check if the printer is available and connected'
      });
    }
  });


  /**
 * Thermal receipt printing endpoint using ESC/POS commands
 *
 * Architecture:
 * 1. Generate ESC/POS commands using node-thermal-printer
 * 2. Get buffer without executing
 * 3. Development: Send to TCP emulator (ZplEscPrinter on port 8100)
 * 4. Production: Use printer.printDirect with RAW type to send to Windows printer name
 */
  api.post('/print-thermal', async (req, res) => {
    let jobKey = null;

    try {
      const { printer: printerInfo, data, totals, widthMM } = req.body;

      // Validate required fields
      if (!printerInfo || !data || !totals || !widthMM) {
        return res.status(400).json({
          error: 'Missing required fields: printer, data, totals, widthMM'
        });
      }

      // Create a unique key for this print job
      jobKey = `${printerInfo.name}-${Date.now()}`;

      // Check if there's already an active job for this printer
      if (activePrintJobs.has(printerInfo.name)) {
        console.log(`Thermal print job already in progress for printer: ${printerInfo.name}`);
        return res.status(409).json({
          error: 'Print job already in progress',
          message: 'Please wait for the current print job to complete'
        });
      }

      // Mark this printer as busy
      activePrintJobs.set(printerInfo.name, jobKey);

      // Calculate optimal character width
      const charWidth = getOptimalCharacterWidth(widthMM);
      console.log(`Thermal print request for printer: ${printerInfo.name}`);
      console.log(`Paper: ${widthMM}mm → ${charWidth} characters per line`);

      const isDevelopment = process.env.NODE_ENV === 'development';

      // Step 1: Generate ESC/POS commands using node-thermal-printer
      // We use a dummy TCP interface - we just want to build the command buffer
      const thermalPrinter = new ThermalPrinter({
        type: PrinterTypes.EPSON, // Compatible with ESC/POS printers (Epson, Rongta, etc.)
        interface: 'tcp://localhost',  // Dummy interface - won't be used
        width: charWidth, // Optimal character count based on paper width
        characterSet: 'PC437_USA',
        removeSpecialCharacters: false,
        lineCharacter: '-',
      });

      // Build the receipt (generates ESC/POS commands in buffer)
      await buildThermalReceipt(thermalPrinter, data, totals);

      // Step 2: Get the buffer WITHOUT executing (don't send to network yet)
      const buffer = await thermalPrinter.getBuffer();

      // Step 3: Send buffer to printer based on environment
      if (isDevelopment) {
        // Development: Send to TCP emulator (ZplEscPrinter on port 8100)
        console.log('Development mode: Sending to TCP emulator at 127.0.0.1:8100');

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('TCP connection timed out after 10 seconds'));
          }, 10000);

          const socket = net.connect(8100, '127.0.0.1');

          socket.on('connect', () => {
            clearTimeout(timeout);
            try {
              socket.write(buffer);
              socket.end();
              console.log('✔️ Thermal receipt sent to emulator successfully');
            } catch (writeError) {
              reject(new Error(`Failed to write to emulator: ${writeError.message}`));
            }
          });

          socket.on('error', (err) => {
            clearTimeout(timeout);
            console.error('TCP connection error:', err);
            socket.destroy();
            reject(new Error(`Failed to connect to emulator: ${err.message}`));
          });

          socket.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } else {
        // Production: Use printer.printDirect with RAW type
        console.log(`Production mode: Sending to printer "${printerInfo.name}" using RAW print`);

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Print operation timed out after 30 seconds'));
          }, 30000);

          try {
            printer.printDirect({
              data: buffer,
              printer: printerInfo.name,  // Windows printer name!
              type: 'RAW',  // This is the key - sends raw ESC/POS bytes
              success: (jobID) => {
                clearTimeout(timeout);
                console.log(`✔️ Thermal receipt sent to printer successfully. Job ID: ${jobID}`);
                resolve(jobID);
              },
              error: (err) => {
                clearTimeout(timeout);
                console.error('Thermal print error:', err);
                reject(new Error(`Print failed: ${err}`));
              }
            });
          } catch (err) {
            clearTimeout(timeout);
            console.error('printDirect threw exception:', err);
            reject(new Error(`Failed to initialize print: ${err.message}`));
          }
        });
      }

      // Remove from active jobs
      if (jobKey && activePrintJobs.get(printerInfo.name) === jobKey) {
        activePrintJobs.delete(printerInfo.name);
      }

      return res.sendStatus(204);

    } catch (error) {
      console.error('Thermal print error:', error);

      // Remove from active jobs
      if (jobKey && activePrintJobs.get(req.body.printer?.name) === jobKey) {
        activePrintJobs.delete(req.body.printer.name);
      }

      // Return a user-friendly error message
      const errorMessage = error.message || 'Unknown thermal print error occurred';
      return res.status(500).json({
        error: 'Thermal print operation failed',
        message: errorMessage,
        details: 'Please check if the printer is available, connected, and supports thermal printing'
      });
    }
  });

  api.listen(21321, '127.0.0.1', () => console.log('▶ Print agent API at http://127.0.0.1:21321'));
}

function broadcastPrinterStatus(printerList) {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'printer-status', printers: printerList });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (e) { }
    }
  });
}

function formatPrinterList(rawPrinters) {
  const mmRegex = /([\d.]+)x([\d.]+)mm/i;

  // List of known PDF/virtual printers
  const pdfPrinters = [
    'Microsoft Print to PDF',
    'Microsoft XPS Document Writer',
    'Adobe PDF',
    'CutePDF Writer',
    'PDFCreator',
    'Foxit Reader PDF Printer',
    'Bullzip PDF Printer',
    'OneNote',
    'Fax'
  ];

  return rawPrinters.map(p => {
    const media = p.options?.media || p.options?.['media-default'] || '';
    const match = mmRegex.exec(media);
    const widthMM = match ? parseFloat(match[1]) : undefined;
    const heightMM = match ? parseFloat(match[2]) : undefined;

    // Determine printer type
    const isPdfPrinter = pdfPrinters.some(pdfPrinter =>
      (p.displayName || p.name).toLowerCase().includes(pdfPrinter.toLowerCase())
    );

    return {
      id: p.name,
      name: p.displayName || p.name,
      isDefault: p.isDefault,
      widthMM,
      heightMM,
      dpi: Number(p.options?.ppi || 203),
      type: isPdfPrinter ? 'pdf' : 'physical',
      supportsThermal: !isPdfPrinter  // PDF printers don't support raw thermal commands
    };
  });
}

module.exports = { startApi, broadcastPrinterStatus, formatPrinterList };
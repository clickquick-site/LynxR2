/**
 * R.Lynx™ Pro - Professional Printing Module
 * Supporte plusieurs types d'imprimantes et formats
 */

const Printing = (() => {
    // Configuration
    const CONFIG = {
        printers: {
            receipt: {
                width: 48, // mm
                characters: 32, // par ligne
                type: 'thermal'
            },
            kitchen: {
                width: 80,
                characters: 42,
                type: 'thermal'
            },
            label: {
                width: 40,
                characters: 24,
                type: 'label'
            },
            a4: {
                width: 210,
                characters: 80,
                type: 'standard'
            }
        },
        paperSizes: {
            '58mm': { width: 58, chars: 32 },
            '80mm': { width: 80, chars: 42 },
            'a4': { width: 210, chars: 80 }
        },
        usbVendors: {
            'epson': [0x04b8, 0x041f],
            'star': [0x0519],
            'bixolon': [0x19a2]
        }
    };

    // État
    let printers = [];
    let defaultPrinter = null;

    /**
     * Initialisation - Détection des imprimantes
     */
    const init = async () => {
        try {
            // Détection USB (via WebUSB si supporté)
            if ('usb' in navigator) {
                await detectUSBPrinters();
            }

            // Détection réseau
            await detectNetworkPrinters();

            // Détection imprimantes par défaut du système
            await detectSystemPrinters();

            console.log('Printers detected:', printers);
        } catch (error) {
            console.error('Printer detection error:', error);
        }
    };

    /**
     * Détection imprimantes USB
     */
    const detectUSBPrinters = async () => {
        try {
            const devices = await navigator.usb.getDevices();
            
            for (const device of devices) {
                const isPrinter = Object.values(CONFIG.usbVendors).flat().includes(device.vendorId);
                
                if (isPrinter) {
                    printers.push({
                        id: `usb-${device.serialNumber || Date.now()}`,
                        name: device.productName || 'USB Printer',
                        type: 'usb',
                        vendorId: device.vendorId,
                        productId: device.productId,
                        device: device
                    });
                }
            }
        } catch (e) {
            console.log('WebUSB not supported or permission denied');
        }
    };

    /**
     * Détection imprimantes réseau (ESC/POS sur IP)
     */
    const detectNetworkPrinters = () => {
        const saved = localStorage.getItem('rlpro_network_printers');
        if (saved) {
            try {
                printers.push(...JSON.parse(saved));
            } catch (e) {}
        }
    };

    /**
     * Détection imprimantes système (via iframe)
     */
    const detectSystemPrinters = () => {
        // Fallback: détection via impression classique
        printers.push({
            id: 'system-default',
            name: 'Imprimante par défaut',
            type: 'system',
            paperSize: '80mm'
        });
    };

    /**
     * Impression ticket
     */
    const printReceipt = async (order, options = {}) => {
        const printer = getPrinter(options.printerId || 'system-default');
        const paperSize = options.paperSize || '80mm';
        
        // Générer contenu
        const content = generateReceiptContent(order, paperSize);
        
        // Choisir méthode d'impression
        switch (printer.type) {
            case 'usb':
                return printUSB(printer, content);
            case 'network':
                return printNetwork(printer, content);
            default:
                return printSystem(content, options);
        }
    };

    /**
     * Génération contenu ticket
     */
    const generateReceiptContent = (order, paperSize = '80mm') => {
        const settings = JSON.parse(localStorage.getItem('rlpro_settings') || '{}');
        const charsPerLine = CONFIG.paperSizes[paperSize]?.chars || 42;
        
        const lines = [];
        
        // En-tête
        lines.push('='.repeat(charsPerLine));
        lines.push(centerText(settings.restaurantName || 'R.Lynx™ RestFast', charsPerLine));
        lines.push(centerText(settings.restaurantAddress || '', charsPerLine));
        lines.push(centerText(`Tel: ${settings.restaurantPhone || ''}`, charsPerLine));
        lines.push('='.repeat(charsPerLine));
        
        // Informations commande
        lines.push('');
        lines.push(`Ticket #${order.number.padStart(6, '0')}`);
        lines.push(`Date: ${new Date(order.closedAt || order.createdAt).toLocaleString('fr-FR')}`);
        lines.push(`Table: ${order.tableId || 'À emporter'}`);
        lines.push(`Serveur: ${order.cashierName || ''}`);
        lines.push('-'.repeat(charsPerLine));
        
        // Articles
        lines.push(formatTwoColumns('Article', 'Total', charsPerLine));
        lines.push('-'.repeat(charsPerLine));
        
        order.items.forEach(item => {
            const name = item.name.substring(0, charsPerLine - 10);
            const priceLine = formatPriceLine(name, item.qty, item.price, item.lineTotal, charsPerLine);
            lines.push(priceLine);
            
            if (item.notes) {
                lines.push(`  (${item.notes.substring(0, charsPerLine - 4)})`);
            }
        });
        
        lines.push('-'.repeat(charsPerLine));
        
        // Totaux
        lines.push(formatTwoColumns('Sous-total', formatMoney(order.subtotal), charsPerLine));
        if (order.tva > 0) {
            lines.push(formatTwoColumns(`TVA (${settings.tva || 9}%)`, formatMoney(order.tva), charsPerLine));
        }
        lines.push('='.repeat(charsPerLine));
        lines.push(formatTwoColumns('TOTAL', formatMoney(order.total), charsPerLine, true));
        
        // Paiement
        lines.push('');
        lines.push(`Paiement: ${formatPaymentMethod(order.paymentMethod)}`);
        lines.push(`Montant payé: ${formatMoney(order.total)}`);
        
        if (order.change > 0) {
            lines.push(`Monnaie rendue: ${formatMoney(order.change)}`);
        }
        
        // Pied de page
        lines.push('');
        lines.push(centerText(settings.ticketFooter || 'Merci de votre visite!', charsPerLine));
        lines.push(centerText('R.Lynx™ Pro v4.0', charsPerLine));
        lines.push('='.repeat(charsPerLine));
        lines.push('');
        lines.push('\n\n'); // Avance papier
        
        return lines.join('\n');
    };

    /**
     * Impression via USB (WebUSB)
     */
    const printUSB = async (printer, content) => {
        try {
            if (!printer.device) {
                // Demander accès
                const device = await navigator.usb.requestDevice({
                    filters: [{ vendorId: printer.vendorId }]
                });
                await device.open();
                await device.selectConfiguration(1);
                await device.claimInterface(0);
                printer.device = device;
            }

            // Convertir en ESC/POS
            const data = textToESCPOS(content);
            
            // Envoyer
            await printer.device.transferOut(1, data);
            
            return { success: true, message: 'Impression envoyée' };
        } catch (error) {
            console.error('USB print error:', error);
            return { success: false, error: error.message };
        }
    };

    /**
     * Impression via réseau (TCP/IP)
     */
    const printNetwork = async (printer, content) => {
        // Simule impression réseau
        return new Promise(resolve => {
            setTimeout(() => {
                console.log('Network print:', content);
                resolve({ success: true });
            }, 500);
        });
    };

    /**
     * Impression système (fallback)
     */
    const printSystem = (content, options = {}) => {
        return new Promise((resolve) => {
            const printWindow = window.open('', '_blank');
            
            if (!printWindow) {
                Toast.show('Ouvrez les pop-ups pour imprimer', 'warning');
                resolve({ success: false, error: 'Pop-up bloqué' });
                return;
            }

            const styles = `
                <style>
                    body { 
                        font-family: 'Courier New', monospace; 
                        font-size: 12px;
                        width: ${options.width || '80mm'};
                        margin: 0 auto;
                        padding: 10px;
                    }
                    .center { text-align: center; }
                    .bold { font-weight: bold; }
                    .total { font-size: 14px; font-weight: bold; }
                    hr { border: none; border-top: 1px dashed #000; }
                </style>
            `;

            printWindow.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Impression R.Lynx</title>
                    ${styles}
                </head>
                <body>
                    <pre>${content}</pre>
                    <script>
                        window.onload = function() {
                            setTimeout(function() {
                                window.print();
                                setTimeout(window.close, 500);
                            }, 200);
                        };
                    </script>
                </body>
                </html>
            `);

            printWindow.document.close();
            resolve({ success: true });
        });
    };

    /**
     * Convertir texte en ESC/POS
     */
    const textToESCPOS = (text) => {
        // ESC/POS commands
        const ESC = 0x1B;
        const GS = 0x1D;
        
        const encoder = new TextEncoder();
        const bytes = [];
        
        // Initialisation
        bytes.push(ESC, 0x40);
        
        // Centre
        bytes.push(ESC, 0x61, 0x01);
        
        // Texte
        bytes.push(...encoder.encode(text));
        
        // Coupe papier
        bytes.push(GS, 0x56, 0x41, 0x00);
        
        return new Uint8Array(bytes);
    };

    /**
     * Utilitaires de formatage
     */
    const centerText = (text, width) => {
        const padding = Math.max(0, Math.floor((width - text.length) / 2));
        return ' '.repeat(padding) + text;
    };

    const formatTwoColumns = (left, right, width, bold = false) => {
        const leftMax = Math.floor(width * 0.6);
        const rightMax = width - leftMax;
        
        const leftTrim = left.length > leftMax ? left.substring(0, leftMax - 3) + '...' : left;
        const rightTrim = right.length > rightMax ? right.substring(0, rightMax - 3) + '...' : right;
        
        const padding = width - leftTrim.length - rightTrim.length;
        
        return leftTrim + ' '.repeat(padding) + rightTrim;
    };

    const formatPriceLine = (name, qty, price, total, width) => {
        const line = `${name} x${qty}`;
        const totalStr = formatMoney(total);
        return formatTwoColumns(line, totalStr, width);
    };

    const formatMoney = (amount) => {
        return `${amount.toLocaleString('fr-FR')} DZD`;
    };

    const formatPaymentMethod = (method) => {
        const methods = {
            'cash': 'Espèces',
            'card': 'Carte bancaire',
            'mobile': 'Paiement mobile'
        };
        return methods[method] || method;
    };

    /**
     * Gestion des imprimantes
     */
    const getPrinter = (printerId) => {
        return printers.find(p => p.id === printerId) || printers[0] || {
            id: 'default',
            name: 'Imprimante par défaut',
            type: 'system'
        };
    };

    const addNetworkPrinter = (printer) => {
        const newPrinter = {
            id: `net-${Date.now()}`,
            name: printer.name,
            type: 'network',
            ip: printer.ip,
            port: printer.port || 9100,
            paperSize: printer.paperSize || '80mm'
        };
        
        printers.push(newPrinter);
        
        // Sauvegarder
        const networkPrinters = printers.filter(p => p.type === 'network');
        localStorage.setItem('rlpro_network_printers', JSON.stringify(networkPrinters));
        
        return newPrinter;
    };

    const removePrinter = (printerId) => {
        printers = printers.filter(p => p.id !== printerId);
        
        const networkPrinters = printers.filter(p => p.type === 'network');
        localStorage.setItem('rlpro_network_printers', JSON.stringify(networkPrinters));
    };

    const testPrinter = async (printerId) => {
        const testContent = `
========================
    TEST IMPRESSION
========================
Date: ${new Date().toLocaleString()}
Imprimante: ${printerId}
------------------------
Cette impression confirme
que votre imprimante est
correctement configurée.
------------------------
R.Lynx™ Pro v4.0
========================

        `;
        
        return printReceipt({ 
            items: [], 
            total: 0,
            number: 'TEST'
        }, { printerId, testMode: true });
    };

    // Initialisation au chargement
    init();

    return {
        printReceipt,
        printKitchen: (order) => printReceipt(order, { printerId: 'kitchen', paperSize: '80mm' }),
        printLabel: (item) => printReceipt({ items: [item], total: item.price }, { printerId: 'label', paperSize: '40mm' }),
        getPrinters: () => printers,
        addNetworkPrinter,
        removePrinter,
        testPrinter,
        generateReceiptContent
    };
})();

// Exposer globalement
window.Printing = Printing;

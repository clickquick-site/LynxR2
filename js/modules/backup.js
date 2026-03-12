/**
 * R.Lynx™ Pro - Automatic Backup Module
 * Sauvegarde automatique et synchronisation cloud
 */

const Backup = (() => {
    const CONFIG = {
        autoBackupInterval: 30 * 60 * 1000, // 30 minutes
        maxBackups: 50,
        cloudSyncEnabled: false,
        cloudProvider: 'local', // 'local', 'dropbox', 'gdrive', 'onedrive'
        compressionEnabled: true
    };

    let backupTimer = null;
    let backupHistory = [];

    /**
     * Initialisation
     */
    const init = async () => {
        // Charger configuration
        loadConfig();
        
        // Charger historique
        loadHistory();
        
        // Démarrer sauvegarde automatique
        startAutoBackup();
        
        // Vérifier nettoyage
        cleanupOldBackups();
    };

    /**
     * Créer une sauvegarde
     */
    const createBackup = async (options = {}) => {
        try {
            const backupId = `backup_${Date.now()}`;
            const timestamp = new Date().toISOString();
            
            // Récupérer toutes les données
            const data = await collectAllData();
            
            // Compresser si nécessaire
            let backupData = data;
            if (CONFIG.compressionEnabled) {
                backupData = await compressData(data);
            }
            
            // Ajouter métadonnées
            const backup = {
                id: backupId,
                timestamp,
                version: '4.0.0',
                size: JSON.stringify(backupData).length,
                data: backupData,
                compression: CONFIG.compressionEnabled ? 'gzip' : 'none',
                type: options.type || 'auto'
            };

            // Sauvegarde locale
            await saveLocalBackup(backup);
            
            // Sauvegarde cloud si activée
            if (CONFIG.cloudSyncEnabled && options.cloud !== false) {
                await syncToCloud(backup);
            }
            
            // Ajouter à l'historique
            backupHistory.push({
                id: backupId,
                timestamp,
                size: backup.size,
                type: backup.type
            });
            
            saveHistory();
            
            // Nettoyage
            cleanupOldBackups();
            
            return { success: true, backupId };
            
        } catch (error) {
            console.error('Backup error:', error);
            return { success: false, error: error.message };
        }
    };

    /**
     * Collecter toutes les données
     */
    const collectAllData = async () => {
        const tables = [
            'users', 'orders', 'items', 'categories', 'tables',
            'settings', 'inventory', 'kitchen_orders', 'activity_logs'
        ];
        
        const data = {};
        
        for (const table of tables) {
            try {
                data[table] = await DB.query(table, 'getAll') || [];
            } catch (e) {
                // Fallback localStorage
                const localData = localStorage.getItem(`rlpro_${table}`);
                if (localData) {
                    data[table] = JSON.parse(localData);
                } else {
                    data[table] = [];
                }
            }
        }
        
        return data;
    };

    /**
     * Sauvegarde locale
     */
    const saveLocalBackup = (backup) => {
        return new Promise((resolve) => {
            // Sauvegarde dans IndexedDB
            if (dbInstance) {
                const transaction = dbInstance.transaction(['backups'], 'readwrite');
                const store = transaction.objectStore('backups');
                store.put(backup);
            }
            
            // Sauvegarde dans localStorage (fallback)
            const backups = JSON.parse(localStorage.getItem('rlpro_backups') || '[]');
            backups.push(backup);
            
            // Garder seulement les X plus récents
            while (backups.length > CONFIG.maxBackups) {
                backups.shift();
            }
            
            localStorage.setItem('rlpro_backups', JSON.stringify(backups));
            
            // Exporter en fichier
            exportBackupFile(backup);
            
            resolve();
        });
    };

    /**
     * Exporter en fichier
     */
    const exportBackupFile = (backup) => {
        const blob = new Blob([JSON.stringify(backup, null, 2)], { 
            type: 'application/json' 
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rlpro_backup_${backup.timestamp.split('T')[0]}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
    };

    /**
     * Compression des données
     */
    const compressData = async (data) => {
        // Utiliser Compression Streams API si disponible
        if ('CompressionStream' in window) {
            const json = JSON.stringify(data);
            const stream = new Blob([json]).stream();
            const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
            const compressedBlob = await new Response(compressedStream).blob();
            
            return {
                compressed: true,
                data: await blobToBase64(compressedBlob)
            };
        }
        
        // Fallback: simple stringify
        return {
            compressed: false,
            data: JSON.stringify(data)
        };
    };

    /**
     * Décompression
     */
    const decompressData = async (backup) => {
        if (!backup.data.compressed) {
            return JSON.parse(backup.data.data);
        }
        
        if ('DecompressionStream' in window) {
            const binary = base64ToBlob(backup.data.data);
            const stream = binary.stream();
            const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
            const decompressedBlob = await new Response(decompressedStream).blob();
            const text = await decompressedBlob.text();
            return JSON.parse(text);
        }
        
        throw new Error('Décompression non supportée');
    };

    /**
     * Restaurer une sauvegarde
     */
    const restoreBackup = async (backupId) => {
        try {
            // Récupérer la sauvegarde
            const backup = await getBackup(backupId);
            if (!backup) {
                throw new Error('Sauvegarde non trouvée');
            }
            
            // Décompresser si nécessaire
            let data = backup.data;
            if (backup.data.compressed) {
                data = await decompressData(backup);
            }
            
            // Restaurer les données
            for (const [table, items] of Object.entries(data)) {
                if (items && Array.isArray(items)) {
                    // Vider la table
                    await clearTable(table);
                    
                    // Insérer les données
                    for (const item of items) {
                        await DB.query(table, 'put', item);
                    }
                }
            }
            
            return { success: true };
            
        } catch (error) {
            console.error('Restore error:', error);
            return { success: false, error: error.message };
        }
    };

    /**
     * Synchronisation cloud
     */
    const syncToCloud = async (backup) => {
        switch(CONFIG.cloudProvider) {
            case 'dropbox':
                return syncDropbox(backup);
            case 'gdrive':
                return syncGoogleDrive(backup);
            case 'onedrive':
                return syncOneDrive(backup);
            default:
                console.log('Cloud sync not configured');
                return false;
        }
    };

    /**
     * Dropbox sync
     */
    const syncDropbox = async (backup) => {
        const token = localStorage.getItem('rlpro_dropbox_token');
        if (!token) return false;
        
        try {
            const content = JSON.stringify(backup);
            const filename = `backups/${backup.timestamp.split('T')[0]}.json`;
            
            const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream',
                    'Dropbox-API-Arg': JSON.stringify({
                        path: `/${filename}`,
                        mode: 'add',
                        autorename: true,
                        mute: false
                    })
                },
                body: content
            });
            
            return response.ok;
            
        } catch (error) {
            console.error('Dropbox sync error:', error);
            return false;
        }
    };

    /**
     * Nettoyage des vieilles sauvegardes
     */
    const cleanupOldBackups = () => {
        const backups = JSON.parse(localStorage.getItem('rlpro_backups') || '[]');
        
        // Trier par date
        backups.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        // Garder seulement maxBackups
        while (backups.length > CONFIG.maxBackups) {
            backups.pop();
        }
        
        localStorage.setItem('rlpro_backups', JSON.stringify(backups));
        
        // Mettre à jour historique
        backupHistory = backups.map(b => ({
            id: b.id,
            timestamp: b.timestamp,
            size: b.size,
            type: b.type
        }));
    };

    /**
     * Charger configuration
     */
    const loadConfig = () => {
        const saved = localStorage.getItem('rlpro_backup_config');
        if (saved) {
            Object.assign(CONFIG, JSON.parse(saved));
        }
    };

    /**
     * Sauvegarder configuration
     */
    const saveConfig = () => {
        localStorage.setItem('rlpro_backup_config', JSON.stringify(CONFIG));
    };

    /**
     * Charger historique
     */
    const loadHistory = () => {
        const saved = localStorage.getItem('rlpro_backup_history');
        if (saved) {
            backupHistory = JSON.parse(saved);
        }
    };

    const saveHistory = () => {
        localStorage.setItem('rlpro_backup_history', JSON.stringify(backupHistory));
    };

    /**
     * Démarrer sauvegarde automatique
     */
    const startAutoBackup = () => {
        if (backupTimer) clearInterval(backupTimer);
        
        backupTimer = setInterval(() => {
            createBackup({ type: 'auto' });
        }, CONFIG.autoBackupInterval);
    };

    /**
     * Arrêter sauvegarde automatique
     */
    const stopAutoBackup = () => {
        if (backupTimer) {
            clearInterval(backupTimer);
            backupTimer = null;
        }
    };

    /**
     * Récupérer liste des sauvegardes
     */
    const getBackups = () => {
        return backupHistory;
    };

    /**
     * Récupérer une sauvegarde spécifique
     */
    const getBackup = async (backupId) => {
        // Chercher dans localStorage
        const backups = JSON.parse(localStorage.getItem('rlpro_backups') || '[]');
        let backup = backups.find(b => b.id === backupId);
        
        // Chercher dans IndexedDB
        if (!backup && dbInstance) {
            const transaction = dbInstance.transaction(['backups'], 'readonly');
            const store = transaction.objectStore('backups');
            backup = await new Promise(resolve => {
                const request = store.get(backupId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
            });
        }
        
        return backup;
    };

    /**
     * Utilitaires
     */
    const blobToBase64 = (blob) => {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
        });
    };

    const base64ToBlob = (base64) => {
        const binary = atob(base64);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            array[i] = binary.charCodeAt(i);
        }
        return new Blob([array]);
    };

    const clearTable = async (table) => {
        // À implémenter selon DB utilisée
        if (dbInstance) {
            const transaction = dbInstance.transaction([table], 'readwrite');
            const store = transaction.objectStore(table);
            store.clear();
        }
    };

    // Initialisation
    init();

    return {
        createBackup,
        restoreBackup,
        getBackups,
        getBackup,
        startAutoBackup,
        stopAutoBackup,
        setConfig: (config) => {
            Object.assign(CONFIG, config);
            saveConfig();
            if (config.autoBackupInterval) {
                startAutoBackup();
            }
        },
        getConfig: () => ({ ...CONFIG }),
        syncToCloud
    };
})();

window.Backup = Backup;

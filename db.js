class TaskDB {
    constructor() {
        this.dbName = 'TaskStackDB';
        this.version = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => {
                console.error('Database failed to open');
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('Database opened successfully');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object stores if they don't exist
                if (!db.objectStoreNames.contains('tasks')) {
                    const taskStore = db.createObjectStore('tasks', { keyPath: 'id' });
                    taskStore.createIndex('createdAt', 'createdAt', { unique: false });
                }

                if (!db.objectStoreNames.contains('completed')) {
                    const completedStore = db.createObjectStore('completed', { keyPath: 'id' });
                    completedStore.createIndex('completedAt', 'completedAt', { unique: false });
                }

                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }

                console.log('Database setup complete');
            };
        });
    }

    async saveTasks(tasks) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tasks'], 'readwrite');
            const store = transaction.objectStore('tasks');

            // Clear existing tasks
            const clearRequest = store.clear();

            clearRequest.onsuccess = () => {
                // Add all tasks
                tasks.forEach(task => {
                    store.add(task);
                });
            };

            transaction.oncomplete = () => {
                console.log('Tasks saved successfully');
                resolve();
            };

            transaction.onerror = () => {
                console.error('Failed to save tasks');
                reject(transaction.error);
            };
        });
    }

    async loadTasks() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tasks'], 'readonly');
            const store = transaction.objectStore('tasks');
            const request = store.getAll();

            request.onsuccess = () => {
                const tasks = request.result || [];
                // Sort by createdAt to maintain order
                tasks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                resolve(tasks);
            };

            request.onerror = () => {
                console.error('Failed to load tasks');
                reject(request.error);
            };
        });
    }

    async saveCompleted(completed) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['completed'], 'readwrite');
            const store = transaction.objectStore('completed');

            // Clear existing completed tasks
            const clearRequest = store.clear();

            clearRequest.onsuccess = () => {
                // Add all completed tasks
                completed.forEach(task => {
                    store.add(task);
                });
            };

            transaction.oncomplete = () => {
                console.log('Completed tasks saved successfully');
                resolve();
            };

            transaction.onerror = () => {
                console.error('Failed to save completed tasks');
                reject(transaction.error);
            };
        });
    }

    async loadCompleted() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['completed'], 'readonly');
            const store = transaction.objectStore('completed');
            const request = store.getAll();

            request.onsuccess = () => {
                const completed = request.result || [];
                // Sort by completedAt descending (most recent first)
                completed.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
                resolve(completed);
            };

            request.onerror = () => {
                console.error('Failed to load completed tasks');
                reject(request.error);
            };
        });
    }

    async saveMetadata(key, value) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');
            const request = store.put({ key, value });

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async loadMetadata(key) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readonly');
            const store = transaction.objectStore('metadata');
            const request = store.get(key);

            request.onsuccess = () => {
                resolve(request.result ? request.result.value : null);
            };

            request.onerror = () => reject(request.error);
        });
    }

    async clearAll() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tasks', 'completed', 'metadata'], 'readwrite');

            transaction.objectStore('tasks').clear();
            transaction.objectStore('completed').clear();
            transaction.objectStore('metadata').clear();

            transaction.oncomplete = () => {
                console.log('All data cleared');
                resolve();
            };

            transaction.onerror = () => {
                console.error('Failed to clear data');
                reject(transaction.error);
            };
        });
    }

    async exportData() {
        const tasks = await this.loadTasks();
        const completed = await this.loadCompleted();
        
        return {
            tasks,
            completed,
            exportedAt: new Date().toISOString()
        };
    }

    async importData(data) {
        if (data.tasks) await this.saveTasks(data.tasks);
        if (data.completed) await this.saveCompleted(data.completed);
    }
}

class FileDB {
    constructor() {
        this.dbPath = './data/tasks.json';
        this.fs = null;
        this.isNode = false;
        this.data = {
            tasks: [],
            completed: [],
            archived: [],
            categories: ['Work', 'Personal']
        };
    }

    async init() {
        // Check if we're in a Node.js environment or browser
        if (typeof window === 'undefined') {
            // Node.js environment
            this.isNode = true;
            this.fs = require('fs').promises;
            await this.ensureDataDirectory();
        } else {
            // Browser environment - we'll use File System Access API
            console.log('Browser environment detected - using File System Access API');
        }
        
        await this.load();
    }

    async ensureDataDirectory() {
        if (this.isNode) {
            const path = require('path');
            const dir = path.dirname(this.dbPath);
            try {
                await this.fs.mkdir(dir, { recursive: true });
            } catch (e) {
                // Directory already exists
            }
        }
    }

    async save() {
        const jsonData = JSON.stringify(this.data, null, 2);
        
        if (this.isNode) {
            // Node.js - direct file write
            await this.fs.writeFile(this.dbPath, jsonData, 'utf8');
            console.log('Data saved to', this.dbPath);
        } else {
            // Browser - download as file
            this.downloadJSON(jsonData);
        }
    }

    downloadJSON(jsonData) {
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'tasks.json';
        a.click();
        URL.revokeObjectURL(url);
        console.log('Data exported as tasks.json');
    }

    async load() {
        try {
            if (this.isNode) {
                const content = await this.fs.readFile(this.dbPath, 'utf8');
                this.data = JSON.parse(content);
                console.log('Data loaded from', this.dbPath);
            } else {
                // Browser - try to load from localStorage as fallback
                const saved = localStorage.getItem('fileDB');
                if (saved) {
                    this.data = JSON.parse(saved);
                    console.log('Data loaded from localStorage');
                }
            }
        } catch (e) {
            console.log('No existing data file, starting fresh');
            this.data = { tasks: [], completed: [], archived: [], categories: ['Work', 'Personal'] };
        }
    }

    async saveTasks(tasks) {
        this.data.tasks = tasks;
        await this.saveToStorage();
    }

    async loadTasks() {
        return this.data.tasks || [];
    }

    async saveCompleted(completed) {
        this.data.completed = completed;
        await this.saveToStorage();
    }

    async loadCompleted() {
        return this.data.completed || [];
    }

    async saveArchived(archived) {
        this.data.archived = archived;
        await this.saveToStorage();
    }

    async loadArchived() {
        return this.data.archived || [];
    }

    async saveCategories(categories) {
        this.data.categories = categories;
        await this.saveToStorage();
    }

    async loadCategories() {
        return this.data.categories || ['Work', 'Personal'];
    }

    async saveToStorage() {
        // Always save to localStorage for browser persistence
        localStorage.setItem('fileDB', JSON.stringify(this.data));
        console.log('Auto-saved to localStorage');
    }

    async exportData() {
        const jsonData = JSON.stringify(this.data, null, 2);
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tasks-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.style.display = 'none';
        
        // Add to document, click, then remove
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Clean up the URL after a short delay
        setTimeout(() => URL.revokeObjectURL(url), 100);
        
        console.log('Exported as:', a.download);
    }

    async importData(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    this.data = JSON.parse(e.target.result);
                    // Migration: ensure categories exist
                    if (!this.data.categories) {
                        this.data.categories = ['Work', 'Personal'];
                    }
                    // Migration: add category to tasks without one
                    if (this.data.tasks) {
                        this.data.tasks.forEach(task => {
                            if (!task.category) task.category = this.data.categories[0];
                        });
                    }
                    await this.saveToStorage();
                    resolve(this.data);
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }
}

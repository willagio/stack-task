class TaskStack {
    constructor() {
        this.stack = [];
        this.completed = [];
        this.archived = [];
        this.categories = ['Work', 'Personal'];
        this.currentCategory = 'Work';
        this.db = new FileDB();
        this.init();
    }

    async init() {
        this.taskInput = document.getElementById('taskInput');
        this.popButton = document.getElementById('popButton');
        this.taskStackEl = document.getElementById('taskStack');
        this.completedTasksEl = document.getElementById('completedTasks');
        this.stackCount = document.querySelector('.stack-count');
        this.tabsListEl = document.getElementById('tabsList');
        this.addCategoryBtn = document.getElementById('addCategoryBtn');

        // Event listeners
        this.taskInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && this.taskInput.value.trim()) {
                this.push(this.taskInput.value.trim());
                this.taskInput.value = '';
            }
        });


        this.popButton.addEventListener('click', () => this.pop());

        // Tab management
        if (this.addCategoryBtn) {
            this.addCategoryBtn.addEventListener('click', () => {
                const name = prompt('Enter category name:');
                if (name) this.createCategory(name);
            });
        }

        // Export/Import buttons
        const exportBtn = document.getElementById('exportBtn');
        const importBtn = document.getElementById('importBtn');
        const importFile = document.getElementById('importFile');

        if (exportBtn && !this.exportBtnInitialized) {
            exportBtn.addEventListener('click', () => this.exportData());
            this.exportBtnInitialized = true;
        }
        if (importBtn && !this.importBtnInitialized) {
            importBtn.addEventListener('click', () => importFile.click());
            this.importBtnInitialized = true;
        }
        if (importFile && !this.importFileInitialized) {
            importFile.addEventListener('change', (e) => this.importData(e));
            this.importFileInitialized = true;
        }

        // Initialize collapsible sections
        document.querySelectorAll('.collapsible-section .section-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Don't toggle if clicking buttons inside header
                if (e.target.tagName === 'BUTTON') return;
                
                const section = header.closest('.collapsible-section');
                section.classList.toggle('collapsed');
            });
        });

        // Initialize database and load data
        await this.loadFromStorage();
    }

    push(task) {
        this.stack.push({
            text: task,
            id: Date.now(),
            createdAt: new Date().toISOString(),
            category: this.currentCategory
        });
        this.render();
        this.saveToStorage();
    }

    pop() {
        if (this.stack.length === 0) return;

        const task = this.stack.pop();
        this.completed.unshift({
            ...task,
            completedAt: new Date().toISOString()
        });
        this.render();
        this.saveToStorage();
    }

    clearCompleted() {
        if (this.completed.length === 0) return;
        
        if (confirm('Clear all completed tasks?')) {
            this.completed = [];
            this.render();
            this.saveToStorage();
        }
    }

    setupDragAndDrop() {
        const taskItems = this.taskStackEl.querySelectorAll('.task-item');
        let draggedElement = null;
        let draggedId = null;

        taskItems.forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedElement = item;
                draggedId = item.getAttribute('data-id');
                
                setTimeout(() => item.classList.add('dragging'), 0);
                
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/html', item.innerHTML);
            });

            item.addEventListener('dragend', (e) => {
                item.classList.remove('dragging');
                taskItems.forEach(i => {
                    i.classList.remove('drag-over-top');
                    i.classList.remove('drag-over-bottom');
                });
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                if (draggedElement !== item) {
                    const rect = item.getBoundingClientRect();
                    const mouseY = e.clientY;
                    const midpoint = rect.top + (rect.height / 2);
                    
                    // Clear previous classes logic
                    taskItems.forEach(i => {
                        if (i !== item) {
                            i.classList.remove('drag-over-top');
                            i.classList.remove('drag-over-bottom');
                        }
                    });

                    if (mouseY < midpoint) {
                        item.classList.add('drag-over-top');
                        item.classList.remove('drag-over-bottom');
                    } else {
                        item.classList.add('drag-over-bottom');
                        item.classList.remove('drag-over-top');
                    }
                }
            });

            item.addEventListener('dragleave', (e) => {
                if (!item.contains(e.relatedTarget)) {
                    item.classList.remove('drag-over-top');
                    item.classList.remove('drag-over-bottom');
                }
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over-top');
                item.classList.remove('drag-over-bottom');
                
                if (draggedElement !== item) {
                    const targetId = item.getAttribute('data-id');
                    const rect = item.getBoundingClientRect();
                    const midpoint = rect.top + (rect.height / 2);
                    
                    // If dropped on top half, insert above (insertBefore=true)
                    const insertBefore = e.clientY < midpoint;
                    
                    this.reorderTasks(draggedId, targetId, insertBefore);
                }
            });
        });
    }


    reorderTasks(draggedId, targetId, insertBefore = true) {
        // Find the indices of the dragged and target tasks
        const draggedIndex = this.stack.findIndex(task => task.id.toString() === draggedId);
        const targetIndex = this.stack.findIndex(task => task.id.toString() === targetId);

        if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) return;

        // Remove the dragged task
        const [draggedTask] = this.stack.splice(draggedIndex, 1);
        
        // Calculate new position
        // Since display is reversed: insertBefore in visual = insert at higher index
        let insertIndex = targetIndex;
        
        // Adjust if we removed something before the target
        if (draggedIndex < targetIndex) {
            insertIndex--;
        }
        
        // Invert the logic for reversed display
        // insertBefore (visual top) = insert after in array (higher index) = above visually
        // !insertBefore (visual bottom) = insert at current index (lower index) = below visually
        if (insertBefore) {
            insertIndex++;
        }
        
        this.stack.splice(insertIndex, 0, draggedTask);

        // Re-render and save
        this.render();
        this.saveToStorage();
    }

    setupTaskActions() {
        // Use event delegation for task action buttons
        this.taskStackEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.task-action-btn');
            if (!btn) return;

            e.stopPropagation(); // Prevent drag events
            const action = btn.getAttribute('data-action');
            const taskId = btn.getAttribute('data-id');

            if (action === 'archive') {
                this.archiveTask(taskId);
            } else if (action === 'remove') {
                this.removeTask(taskId);
            }
        });
    }

    removeTask(taskId) {
        const index = this.stack.findIndex(task => task.id.toString() === taskId);
        if (index === -1) return;

        const task = this.stack[index];
        if (confirm(`Permanently delete "${task.text}"?`)) {
            this.stack.splice(index, 1);
            this.render();
            this.saveToStorage();
        }
    }

    archiveTask(taskId) {
        const index = this.stack.findIndex(task => task.id.toString() === taskId);
        if (index === -1) return;

        const task = this.stack.splice(index, 1)[0];
        this.archived.unshift({
            ...task,
            archivedAt: new Date().toISOString()
        });
        this.render();
        this.saveToStorage();
    }

    restoreTask(taskId) {
        const index = this.archived.findIndex(task => task.id.toString() === taskId);
        if (index === -1) return;

        const task = this.archived.splice(index, 1)[0];
        // Remove archivedAt property
        delete task.archivedAt;
        // Add back to the bottom of the stack (index 0)
        this.stack.unshift(task);
        this.render();
        this.saveToStorage();
    }

    deleteArchivedTask(taskId) {
        const index = this.archived.findIndex(task => task.id.toString() === taskId);
        if (index === -1) return;

        const task = this.archived[index];
        if (confirm(`Permanently delete archived task "${task.text}"?`)) {
            this.archived.splice(index, 1);
            this.render();
            this.saveToStorage();
        }
    }

    restoreCompletedTask(taskId) {
        const index = this.completed.findIndex(task => task.id.toString() === taskId);
        if (index === -1) return;

        const task = this.completed.splice(index, 1)[0];
        // Remove completedAt property
        delete task.completedAt;
        // Add back to the bottom of the stack (index 0)
        this.stack.unshift(task);
        this.render();
        this.saveToStorage();
    }

    deleteCompletedTask(taskId) {
        const index = this.completed.findIndex(task => task.id.toString() === taskId);
        if (index === -1) return;

        const task = this.completed[index];
        if (confirm(`Permanently delete completed task "${task.text}"?`)) {
            this.completed.splice(index, 1);
            this.render();
            this.saveToStorage();
        }
    }

    // Category Management Methods
    createCategory(name) {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        
        if (this.categories.includes(trimmedName)) {
            alert('Category already exists!');
            return;
        }
        
        this.categories.push(trimmedName);
        this.currentCategory = trimmedName;
        this.render();
        this.saveToStorage();
    }

    renameCategory(oldName, newName) {
        const trimmedName = newName.trim();
        if (!trimmedName) return;
        
        if (this.categories.includes(trimmedName) && trimmedName !== oldName) {
            alert('Category name already exists!');
            return;
        }
        
        const index = this.categories.indexOf(oldName);
        if (index === -1) return;
        
        this.categories[index] = trimmedName;
        
        // Update all tasks with this category
        this.stack.forEach(task => {
            if (task.category === oldName) task.category = trimmedName;
        });
        this.completed.forEach(task => {
            if (task.category === oldName) task.category = trimmedName;
        });
        this.archived.forEach(task => {
            if (task.category === oldName) task.category = trimmedName;
        });
        
        if (this.currentCategory === oldName) {
            this.currentCategory = trimmedName;
        }
        
        this.render();
        this.saveToStorage();
    }

    deleteCategory(name) {
        if (this.categories.length === 1) {
            alert('Cannot delete the last category!');
            return;
        }
        
        // Count tasks that will be deleted
        const tasksCount = this.stack.filter(task => task.category === name).length;
        const completedCount = this.completed.filter(task => task.category === name).length;
        const archivedCount = this.archived.filter(task => task.category === name).length;
        const totalCount = tasksCount + completedCount + archivedCount;
        
        const message = totalCount > 0 
            ? `Delete category "${name}" and ${totalCount} task(s) in it?`
            : `Delete category "${name}"?`;
        
        if (!confirm(message)) {
            return;
        }
        
        const index = this.categories.indexOf(name);
        if (index === -1) return;
        
        this.categories.splice(index, 1);
        
        // Remove all tasks with this category
        this.stack = this.stack.filter(task => task.category !== name);
        this.completed = this.completed.filter(task => task.category !== name);
        this.archived = this.archived.filter(task => task.category !== name);
        
        if (this.currentCategory === name) {
            this.currentCategory = this.categories[0];
        }
        
        this.render();
        this.saveToStorage();
    }

    switchCategory(name) {
        if (!this.categories.includes(name)) return;
        this.currentCategory = name;
        this.render();
        this.saveToStorage();
    }

    getFilteredTasks() {
        return this.stack.filter(task => task.category === this.currentCategory);
    }

    getFilteredCompleted() {
        return this.completed.filter(task => task.category === this.currentCategory);
    }

    getFilteredArchived() {
        return this.archived.filter(task => task.category === this.currentCategory);
    }

    render() {
        this.renderTabs();
        this.renderStack();
        this.renderArchived();
        this.renderCompleted();
        this.updateControls();
    }

    renderTabs() {
        if (!this.tabsListEl) return;
        
        this.tabsListEl.innerHTML = this.categories.map(category => `
            <div class="tab ${category === this.currentCategory ? 'tab-active' : ''}" 
                 draggable="true" 
                 data-category="${this.escapeHtml(category)}">
                <span class="tab-name">${this.escapeHtml(category)}</span>
                <button class="tab-close" data-category="${this.escapeHtml(category)}" title="Delete category">×</button>
            </div>
        `).join('');
        
        // Add event listeners for tabs
        this.tabsListEl.querySelectorAll('.tab').forEach(tab => {
            const categoryName = tab.getAttribute('data-category');
            
            // Click to switch category
            tab.addEventListener('click', (e) => {
                if (e.target.classList.contains('tab-close')) return;
                this.switchCategory(categoryName);
            });
            
            // Double-click to rename
            tab.addEventListener('dblclick', (e) => {
                if (e.target.classList.contains('tab-close')) return;
                const newName = prompt('Rename category:', categoryName);
                if (newName) this.renameCategory(categoryName, newName);
            });
            
            // Drag and drop for reordering
            tab.addEventListener('dragstart', (e) => {
                tab.classList.add('dragging-tab');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/html', categoryName);
            });
            
            tab.addEventListener('dragend', (e) => {
                tab.classList.remove('dragging-tab');
                this.tabsListEl.querySelectorAll('.tab').forEach(t => {
                    t.classList.remove('drag-over-left');
                    t.classList.remove('drag-over-right');
                });
            });
            
            tab.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                const draggingTab = this.tabsListEl.querySelector('.dragging-tab');
                if (draggingTab && draggingTab !== tab) {
                    const rect = tab.getBoundingClientRect();
                    const mouseX = e.clientX;
                    const midpoint = rect.left + (rect.width / 2);
                    
                    // Clear previous classes
                    this.tabsListEl.querySelectorAll('.tab').forEach(t => {
                        if (t !== tab) {
                            t.classList.remove('drag-over-left');
                            t.classList.remove('drag-over-right');
                        }
                    });
                    
                    if (mouseX < midpoint) {
                        tab.classList.add('drag-over-left');
                        tab.classList.remove('drag-over-right');
                    } else {
                        tab.classList.add('drag-over-right');
                        tab.classList.remove('drag-over-left');
                    }
                }
            });
            
            tab.addEventListener('dragleave', (e) => {
                if (!tab.contains(e.relatedTarget)) {
                    tab.classList.remove('drag-over-left');
                    tab.classList.remove('drag-over-right');
                }
            });
            
            tab.addEventListener('drop', (e) => {
                e.preventDefault();
                tab.classList.remove('drag-over-left');
                tab.classList.remove('drag-over-right');
                
                const draggingTab = this.tabsListEl.querySelector('.dragging-tab');
                if (draggingTab && draggingTab !== tab) {
                    const draggedCategory = draggingTab.getAttribute('data-category');
                    const targetCategory = tab.getAttribute('data-category');
                    const rect = tab.getBoundingClientRect();
                    const midpoint = rect.left + (rect.width / 2);
                    const insertBefore = e.clientX < midpoint;
                    
                    this.reorderCategories(draggedCategory, targetCategory, insertBefore);
                }
            });
        });
        
        // Add event listeners for close buttons
        this.tabsListEl.querySelectorAll('.tab-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const categoryName = btn.getAttribute('data-category');
                this.deleteCategory(categoryName);
            });
        });
    }

    reorderCategories(draggedName, targetName, insertBefore) {
        const draggedIndex = this.categories.indexOf(draggedName);
        const targetIndex = this.categories.indexOf(targetName);
        
        if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) return;
        
        // Remove the dragged category
        const [draggedCategory] = this.categories.splice(draggedIndex, 1);
        
        // Calculate new position
        let insertIndex = targetIndex;
        
        // Adjust if we removed something before the target
        if (draggedIndex < targetIndex) {
            insertIndex--;
        }
        
        // Insert before or after based on mouse position
        if (!insertBefore) {
            insertIndex++;
        }
        
        this.categories.splice(insertIndex, 0, draggedCategory);
        
        // Re-render and save
        this.render();
        this.saveToStorage();
    }

    renderStack() {
        const filteredStack = this.getFilteredTasks();
        
        if (filteredStack.length === 0) {
            this.taskStackEl.innerHTML = '<div class="empty-state">No tasks in stack<br>Add one to get started!</div>';
            return;
        }

        this.taskStackEl.innerHTML = filteredStack
            .map((task, index) => {
                const isTop = index === filteredStack.length - 1;
                return `
                    <div class="task-item ${isTop ? 'top-task' : ''}" draggable="true" data-id="${task.id}">
                        <div class="drag-handle">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <circle cx="6" cy="4" r="1" fill="currentColor"/>
                                <circle cx="10" cy="4" r="1" fill="currentColor"/>
                                <circle cx="6" cy="8" r="1" fill="currentColor"/>
                                <circle cx="10" cy="8" r="1" fill="currentColor"/>
                                <circle cx="6" cy="12" r="1" fill="currentColor"/>
                                <circle cx="10" cy="12" r="1" fill="currentColor"/>
                            </svg>
                        </div>
                        <div class="task-index">#${filteredStack.length - index}</div>
                        <div class="task-text">${this.escapeHtml(task.text)}</div>
                        <div class="task-actions">
                            <button class="task-action-btn archive-btn" data-action="archive" data-id="${task.id}" title="Archive task">
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                    <path d="M1 3.5H13M2.5 3.5V11.5C2.5 12.0523 2.94772 12.5 3.5 12.5H10.5C11.0523 12.5 11.5 12.0523 11.5 11.5V3.5M4.5 1.5H9.5M5.5 6.5H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <button class="task-action-btn remove-btn" data-action="remove" data-id="${task.id}" title="Remove task">
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                    <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;
            })
            .reverse()
            .join('');
        
        // Add drag and drop event listeners
        this.setupDragAndDrop();
        
        // Add task action event listeners
        this.setupTaskActions();
    }

    renderCompleted() {
        const filteredCompleted = this.getFilteredCompleted();
        
        if (filteredCompleted.length === 0) {
            this.completedTasksEl.innerHTML = '<div class="empty-state">No completed tasks yet</div>';
            return;
        }

        this.completedTasksEl.innerHTML = filteredCompleted
            .map(task => `
                <div class="completed-item" data-id="${task.id}">
                    <div class="completed-content">
                        <div class="completed-text">${this.escapeHtml(task.text)}</div>
                        <div class="completed-time">${this.formatTime(task.completedAt)}</div>
                    </div>
                    <div class="completed-actions">
                        <button class="restore-completed-btn" data-id="${task.id}" title="Restore to stack">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M7 3.5V10.5M7 3.5L4.5 6M7 3.5L9.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <button class="delete-completed-btn" data-id="${task.id}" title="Permanently delete">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `)
            .join('');

        // Add event listeners
        this.completedTasksEl.addEventListener('click', (e) => {
            const restoreBtn = e.target.closest('.restore-completed-btn');
            const deleteBtn = e.target.closest('.delete-completed-btn');
            
            if (restoreBtn) {
                const taskId = restoreBtn.getAttribute('data-id');
                this.restoreCompletedTask(taskId);
            } else if (deleteBtn) {
                const taskId = deleteBtn.getAttribute('data-id');
                this.deleteCompletedTask(taskId);
            }
        });
    }

    renderArchived() {
        const archivedEl = document.getElementById('archivedTasks');
        if (!archivedEl) return;

        const filteredArchived = this.getFilteredArchived();
        
        if (filteredArchived.length === 0) {
            archivedEl.innerHTML = '<div class="empty-state">No archived tasks</div>';
            return;
        }

        archivedEl.innerHTML = filteredArchived
            .map(task => `
                <div class="archived-item" data-id="${task.id}">
                    <div class="archived-content">
                        <div class="archived-text">${this.escapeHtml(task.text)}</div>
                        <div class="archived-time">${this.formatTime(task.archivedAt)}</div>
                    </div>
                    <div class="archived-actions">
                        <button class="restore-btn" data-id="${task.id}" title="Restore to stack">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M7 3.5V10.5M7 3.5L4.5 6M7 3.5L9.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <button class="delete-archived-btn" data-id="${task.id}" title="Permanently delete">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `)
            .join('');

        // Add event listeners
        archivedEl.addEventListener('click', (e) => {
            const restoreBtn = e.target.closest('.restore-btn');
            const deleteBtn = e.target.closest('.delete-archived-btn');
            
            if (restoreBtn) {
                const taskId = restoreBtn.getAttribute('data-id');
                this.restoreTask(taskId);
            } else if (deleteBtn) {
                const taskId = deleteBtn.getAttribute('data-id');
                this.deleteArchivedTask(taskId);
            }
        });
    }

    updateControls() {
        const filteredStack = this.getFilteredTasks();
        this.stackCount.textContent = filteredStack.length;
        this.popButton.disabled = filteredStack.length === 0;
    }

    formatTime(isoString) {
        const date = new Date(isoString);
        const now = new Date();
        const diff = now - date;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        
        return date.toLocaleDateString();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async saveToStorage() {
        try {
            await this.db.saveTasks(this.stack);
            await this.db.saveCompleted(this.completed);
            await this.db.saveArchived(this.archived);
            await this.db.saveCategories(this.categories);
            
            // Also save to localStorage as backup
            localStorage.setItem('taskStack', JSON.stringify(this.stack));
            localStorage.setItem('completedTasks', JSON.stringify(this.completed));
            localStorage.setItem('archivedTasks', JSON.stringify(this.archived));
            localStorage.setItem('categories', JSON.stringify(this.categories));
            localStorage.setItem('currentCategory', this.currentCategory);
        } catch (e) {
            console.error('Failed to save to database:', e);
            // Fallback to localStorage only
            try {
                localStorage.setItem('taskStack', JSON.stringify(this.stack));
                localStorage.setItem('completedTasks', JSON.stringify(this.completed));
                localStorage.setItem('archivedTasks', JSON.stringify(this.archived));
                localStorage.setItem('categories', JSON.stringify(this.categories));
                localStorage.setItem('currentCategory', this.currentCategory);
            } catch (lsError) {
                console.error('Failed to save to localStorage:', lsError);
            }
        }
    }

    async loadFromStorage() {
        try {
            // Try to load from IndexedDB first
            await this.db.init();
            const tasks = await this.db.loadTasks();
            const completed = await this.db.loadCompleted();
            const archived = await this.db.loadArchived();
            const categories = await this.db.loadCategories();

            // If IndexedDB has data, use it
            if (tasks.length > 0 || completed.length > 0 || archived.length > 0 || categories.length > 0) {
                this.stack = tasks;
                this.completed = completed;
                this.archived = archived;
                this.categories = categories.length > 0 ? categories : ['Work', 'Personal'];
                
                // Migrate tasks without category
                this.migrateTasksWithoutCategory();
                
                // Load current category from localStorage
                const savedCurrentCategory = localStorage.getItem('currentCategory');
                if (savedCurrentCategory && this.categories.includes(savedCurrentCategory)) {
                    this.currentCategory = savedCurrentCategory;
                } else {
                    this.currentCategory = this.categories[0];
                }
                
                console.log('Loaded from IndexedDB');
            } else {
                // Otherwise, try to migrate from localStorage
                await this.migrateFromLocalStorage();
            }

            this.render();
        } catch (e) {
            console.error('Failed to load from database:', e);
            // Fallback to localStorage
            await this.migrateFromLocalStorage();
            this.render();
        }
    }

    async migrateFromLocalStorage() {
        try {
            const savedStack = localStorage.getItem('taskStack');
            const savedCompleted = localStorage.getItem('completedTasks');
            const savedArchived = localStorage.getItem('archivedTasks');
            const savedCategories = localStorage.getItem('categories');
            const savedCurrentCategory = localStorage.getItem('currentCategory');

            if (savedStack) {
                this.stack = JSON.parse(savedStack);
            }
            if (savedCompleted) {
                this.completed = JSON.parse(savedCompleted);
            }
            if (savedArchived) {
                this.archived = JSON.parse(savedArchived);
            }
            if (savedCategories) {
                this.categories = JSON.parse(savedCategories);
            }
            if (savedCurrentCategory && this.categories.includes(savedCurrentCategory)) {
                this.currentCategory = savedCurrentCategory;
            }
            
            // Migrate tasks without category
            this.migrateTasksWithoutCategory();

            // If we found data in localStorage, save it to FileDB
            if (this.stack.length > 0 || this.completed.length > 0 || this.archived.length > 0) {
                console.log('Migrating data from localStorage to FileDB');
                await this.saveToStorage();
            }
        } catch (e) {
            console.error('Failed to migrate from localStorage:', e);
        }
    }

    migrateTasksWithoutCategory() {
        const defaultCategory = this.categories[0];
        
        this.stack.forEach(task => {
            if (!task.category) task.category = defaultCategory;
        });
        this.completed.forEach(task => {
            if (!task.category) task.category = defaultCategory;
        });
        this.archived.forEach(task => {
            if (!task.category) task.category = defaultCategory;
        });
    }

    async exportData() {
        try {
            await this.db.exportData();
            console.log('Data exported successfully');
        } catch (e) {
            console.error('Failed to export data:', e);
            alert('Failed to export data. Check console for details.');
        }
    }

    async importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Prevent duplicate imports
        if (this.importing) {
            console.log('Import already in progress, skipping...');
            return;
        }

        this.importing = true;

        try {
            const data = await this.db.importData(file);
            this.stack = data.tasks || [];
            this.completed = data.completed || [];
            this.render();
            console.log('Data imported successfully');
            alert('Data imported successfully!');
        } catch (e) {
            console.error('Failed to import data:', e);
            alert('Failed to import data. Please check the file format.');
        } finally {
            this.importing = false;
            // Reset file input
            event.target.value = '';
        }
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    const app = new TaskStack();
});

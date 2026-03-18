/**
 * SillyTavern Preset Manager — app.js
 * Standalone browser-based preset viewer/editor
 */

(() => {
    'use strict';

    // ==================== STATE ====================
    const state = {
        presets: [],       // Array of { id, name, data, fileName }
        activeIndex: -1,   // Index into presets[]
        editingPromptId: null,
        isNewPrompt: false,
        saveTimer: null,
    };

    // Known marker identifiers (content injected by ST engine)
    const KNOWN_MARKERS = new Set([
        'chatHistory', 'worldInfoBefore', 'worldInfoAfter',
        'charDescription', 'charPersonality', 'scenario',
        'dialogueExamples', 'personaDescription'
    ]);

    // Descriptions of what data each marker injects
    const MARKER_DESCRIPTIONS = {
        chatHistory:        { source: 'Chat Messages',          desc: 'The actual conversation messages between User and Character are inserted here.' },
        worldInfoBefore:    { source: 'Lorebook (Before)',       desc: 'Lorebook/World Info entries matching current context keywords, placed BEFORE chat history.' },
        worldInfoAfter:     { source: 'Lorebook (After)',        desc: 'Lorebook/World Info entries matching current context keywords, placed AFTER chat history.' },
        charDescription:    { source: 'Character Description',   desc: 'Injected from the character card\'s "Description" field.' },
        charPersonality:    { source: 'Character Personality',   desc: 'Injected from the character card\'s "Personality" field.' },
        scenario:           { source: 'Scenario',                desc: 'Injected from the character card\'s "Scenario" field.' },
        dialogueExamples:   { source: 'Example Dialogue',        desc: 'Injected from the character card\'s "Example Messages" blocks.' },
        personaDescription: { source: 'User Persona',            desc: 'Injected from the active user persona\'s description.' },
    };

    // Sampling parameters config
    const SAMPLING_PARAMS = [
        { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01, default: 1 },
        { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01, default: 1 },
        { key: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, default: 0 },
        { key: 'top_a', label: 'Top A', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'frequency_penalty', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01, default: 0 },
        { key: 'presence_penalty', label: 'Presence Penalty', min: -2, max: 2, step: 0.01, default: 0 },
        { key: 'repetition_penalty', label: 'Repetition Penalty', min: 0, max: 3, step: 0.01, default: 1 },
    ];


    const MODEL_KEYS = [
        { key: 'openai_model', label: 'OpenAI' },
        { key: 'claude_model', label: 'Claude' },
        { key: 'google_model', label: 'Google' },
        { key: 'openrouter_model', label: 'OpenRouter' },
        { key: 'custom_model', label: 'Custom' },
    ];

    const SPECIAL_PROMPT_KEYS = [
        { key: 'impersonation_prompt', label: 'Impersonation Prompt' },
        { key: 'new_chat_prompt', label: 'New Chat Prompt' },
        { key: 'new_group_chat_prompt', label: 'New Group Chat Prompt' },
        { key: 'new_example_chat_prompt', label: 'New Example Chat Prompt' },
        { key: 'continue_nudge_prompt', label: 'Continue Nudge Prompt' },
        { key: 'group_nudge_prompt', label: 'Group Nudge Prompt' },
        { key: 'assistant_prefill', label: 'Assistant Prefill' },
        { key: 'assistant_impersonation', label: 'Assistant Impersonation' },
        { key: 'wi_format', label: 'World Info Format' },
        { key: 'scenario_format', label: 'Scenario Format' },
        { key: 'personality_format', label: 'Personality Format' },
    ];

    // ==================== DOM REFS ====================
    const $ = id => document.getElementById(id);
    const presetNameDisplay = $('presetNameDisplay');
    const dropZone = $('dropZone');
    const fileInput = $('fileInput');
    const presetListEl = $('presetList');
    const emptyState = $('emptyState');
    const editorContainer = $('editorContainer');
    const promptOrderList = $('promptOrderList');
    const modelBadges = $('modelBadges');
    const specialPromptsGrid = $('specialPromptsGrid');
    const jsonPreviewContent = $('jsonPreviewContent');
    const toastContainer = $('toastContainer');

    // Modal
    const modalOverlay = $('promptModal');
    const modalTitle = $('modalTitle');
    const modalPromptName = $('modalPromptName');
    const modalPromptRole = $('modalPromptRole');
    const modalPromptId = $('modalPromptId');
    const modalPromptContent = $('modalPromptContent');
    const modalPromptMarker = $('modalPromptMarker');

    // ==================== HELPERS ====================
    function toast(message, type = 'success') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        toastContainer.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    function getActivePreset() {
        return state.activeIndex >= 0 ? state.presets[state.activeIndex]?.data : null;
    }

    function getPromptOrder(data) {
        // Prefer character_id 100001 (default), fallback to first entry
        if (!data.prompt_order || data.prompt_order.length === 0) return [];
        const defaultOrder = data.prompt_order.find(po => po.character_id === 100001);
        return (defaultOrder || data.prompt_order[0]).order || [];
    }

    function setPromptOrder(data, order) {
        if (!data.prompt_order || data.prompt_order.length === 0) {
            data.prompt_order = [{ character_id: 100001, order }];
        } else {
            const idx = data.prompt_order.findIndex(po => po.character_id === 100001);
            if (idx >= 0) {
                data.prompt_order[idx].order = order;
            } else {
                data.prompt_order[0].order = order;
            }
        }
    }

    function getPromptDef(data, identifier) {
        return data.prompts?.find(p => p.identifier === identifier);
    }

    function getPromptType(promptDef) {
        if (!promptDef) return 'marker';
        if (promptDef.marker) return 'marker';
        if (KNOWN_MARKERS.has(promptDef.identifier)) return 'marker';
        if (['main', 'nsfw', 'jailbreak'].includes(promptDef.identifier)) return 'system';
        return 'custom';
    }

    function syntaxHighlightJSON(json) {
        return json.replace(/("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, match => {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                cls = /:$/.test(match) ? 'json-key' : 'json-string';
            } else if (/true|false/.test(match)) {
                cls = 'json-boolean';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return `<span class="${cls}">${match}</span>`;
        });
    }

    // ==================== FILE HANDLING ====================
    function loadFiles(files) {
        Array.from(files).forEach(file => {
            if (!file.name.endsWith('.json')) {
                toast(`Skipped "${file.name}" — not a JSON file`, 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    const name = file.name.replace(/\.json$/i, '');
                    // Save to server
                    const res = await fetch('/api/presets', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, data }),
                    });
                    const result = await res.json();
                    state.presets.push({ id: result.id, name, data, fileName: file.name });
                    renderPresetList();
                    if (state.presets.length === 1) selectPreset(0);
                    toast(`Uploaded "${name}"`);
                } catch (err) {
                    toast(`Failed to load "${file.name}": ${err.message}`, 'error');
                }
            };
            reader.readAsText(file);
        });
    }

    // Drop zone events
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        loadFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) loadFiles(fileInput.files);
        fileInput.value = '';
    });

    // ==================== SAMPLE PRESET ====================
    $('btnLoadSample').addEventListener('click', async () => {
        try {
            const res = await fetch('sample_preset.json');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            state.presets.push({ name: 'Sample (Default)', data, fileName: 'sample_preset.json' });
            renderPresetList();
            selectPreset(state.presets.length - 1);
            toast('Sample preset loaded');
        } catch (err) {
            toast('Could not load sample: ' + err.message, 'error');
        }
    });

    // ==================== NEW PRESET ====================
    $('btnNewPreset').addEventListener('click', async () => {
        const data = createBlankPreset();
        try {
            const res = await fetch('/api/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'New Preset', data }),
            });
            const result = await res.json();
            state.presets.push({ id: result.id, name: 'New Preset', data, fileName: 'new_preset.json' });
            renderPresetList();
            selectPreset(state.presets.length - 1);
            toast('Created new blank preset');
        } catch (err) {
            // Fallback: still add locally
            state.presets.push({ name: 'New Preset', data, fileName: 'new_preset.json' });
            renderPresetList();
            selectPreset(state.presets.length - 1);
            toast('Created locally (server save failed)', 'error');
        }
    });

    function createBlankPreset() {
        return {
            chat_completion_source: 'openai',
            openai_model: 'gpt-4-turbo',
            claude_model: 'claude-sonnet-4-5',
            google_model: 'gemini-2.5-pro',
            openrouter_model: '',
            custom_model: '',
            custom_url: '',
            temperature: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            top_p: 1,
            top_k: 0,
            top_a: 0,
            min_p: 0,
            repetition_penalty: 1,
            openai_max_context: 4095,
            openai_max_tokens: 300,
            names_behavior: 0,
            send_if_empty: '',
            impersonation_prompt: "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
            new_chat_prompt: '[Start a new Chat]',
            new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
            new_example_chat_prompt: '[Example Chat]',
            continue_nudge_prompt: '[Continue your last message without repeating its original content.]',
            group_nudge_prompt: '[Write the next reply only as {{char}}.]',
            bias_preset_selected: 'Default (none)',
            reverse_proxy: '',
            proxy_password: '',
            max_context_unlocked: false,
            wi_format: '{0}',
            scenario_format: '{{scenario}}',
            personality_format: '{{personality}}',
            stream_openai: true,
            assistant_prefill: '',
            assistant_impersonation: '',
            prompts: [
                { name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.", identifier: 'main' },
                { name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', identifier: 'nsfw' },
                { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
                { name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', identifier: 'jailbreak' },
                { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
                { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
                { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
                { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
                { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
                { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
                { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
            ],
            prompt_order: [{
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'worldInfoBefore', enabled: true },
                    { identifier: 'personaDescription', enabled: true },
                    { identifier: 'charDescription', enabled: true },
                    { identifier: 'charPersonality', enabled: true },
                    { identifier: 'scenario', enabled: true },
                    { identifier: 'nsfw', enabled: true },
                    { identifier: 'worldInfoAfter', enabled: true },
                    { identifier: 'dialogueExamples', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                    { identifier: 'jailbreak', enabled: true },
                ]
            }],
            seed: -1,
            n: 1,
        };
    }

    // ==================== EXPORT ====================
    $('btnExport').addEventListener('click', () => {
        const data = getActivePreset();
        if (!data) return;
        const preset = state.presets[state.activeIndex];
        const json = JSON.stringify(data, null, 4);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = preset.fileName || (preset.name + '.json');
        a.click();
        URL.revokeObjectURL(url);
        toast('Preset exported!');
    });

    // ==================== PRESET LIST ====================
    function renderPresetList() {
        presetListEl.innerHTML = '';
        state.presets.forEach((preset, i) => {
            const item = document.createElement('div');
            item.className = 'preset-list-item' + (i === state.activeIndex ? ' active' : '');
            const promptCount = preset.data.prompts?.length || 0;
            const source = preset.data.chat_completion_source || 'unknown';
            item.innerHTML = `
                <div class="preset-dot"></div>
                <div class="preset-info">
                    <div class="preset-title">${escapeHtml(preset.name)}</div>
                    <div class="preset-meta">${promptCount} prompts · ${source}</div>
                </div>
                <button class="preset-remove" title="Remove from list">✕</button>
            `;
            item.addEventListener('click', async (e) => {
                if (e.target.closest('.preset-remove')) {
                    // Delete from server
                    if (preset.id) {
                        try {
                            await fetch(`/api/presets/${preset.id}`, { method: 'DELETE' });
                        } catch (err) {
                            console.error('Server delete failed:', err);
                        }
                    }
                    state.presets.splice(i, 1);
                    if (state.activeIndex === i) {
                        state.activeIndex = -1;
                        showEmptyState();
                    } else if (state.activeIndex > i) {
                        state.activeIndex--;
                    }
                    renderPresetList();
                    toast('Preset deleted');
                    return;
                }
                selectPreset(i);
            });
            presetListEl.appendChild(item);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function selectPreset(index) {
        state.activeIndex = index;
        const preset = state.presets[index];
        presetNameDisplay.textContent = preset.name;
        $('btnExport').disabled = false;
        emptyState.style.display = 'none';
        editorContainer.style.display = 'flex';
        editorContainer.style.flexDirection = 'column';
        editorContainer.style.overflow = 'hidden';
        editorContainer.style.flex = '1';
        renderPresetList();
        renderAll();
    }

    function showEmptyState() {
        emptyState.style.display = '';
        editorContainer.style.display = 'none';
        presetNameDisplay.textContent = 'No preset loaded';
        $('btnExport').disabled = true;
    }

    // ==================== RENDER ALL ====================
    function renderAll() {
        const data = getActivePreset();
        if (!data) return;
        renderPromptOrder(data);
        renderSettings(data);
        renderModelBadges(data);
        renderSpecialPrompts(data);
        renderJsonPreview(data);
    }

    // ==================== RENDER PROMPT ORDER ====================
    function renderPromptOrder(data) {
        promptOrderList.innerHTML = '';
        const order = getPromptOrder(data);

        order.forEach((item, idx) => {
            const def = getPromptDef(data, item.identifier);
            const type = getPromptType(def);
            const name = def?.name || item.identifier;

            const el = document.createElement('div');
            el.className = 'prompt-item' + (item.enabled ? '' : ' disabled');
            el.dataset.index = idx;
            el.draggable = true;

            const badgeClass = type === 'marker' ? 'badge-marker' : type === 'system' ? 'badge-system' : 'badge-custom';
            const badgeLabel = type === 'marker' ? 'MARKER' : type === 'system' ? 'SYSTEM' : 'CUSTOM';
            const isMarker = type === 'marker';
            const markerInfo = isMarker ? MARKER_DESCRIPTIONS[item.identifier] : null;
            const markerSource = markerInfo ? markerInfo.source : '';

            // Markers get info icon, editable prompts get edit icon
            const actionBtn = isMarker
                ? `<button class="prompt-edit-btn prompt-info-btn" data-identifier="${item.identifier}" title="${escapeHtml(markerInfo?.desc || 'Engine-injected marker')}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                   </button>`
                : `<button class="prompt-edit-btn" data-identifier="${item.identifier}" title="Edit prompt">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                   </button>`;

            el.innerHTML = `
                <div class="drag-handle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
                </div>
                <span class="prompt-type-badge ${badgeClass}">${badgeLabel}</span>
                <div>
                    <span class="prompt-name">${escapeHtml(name)}</span>
                    ${isMarker && markerSource ? `<span class="prompt-source">← ${escapeHtml(markerSource)}</span>` : ''}
                    <span class="prompt-identifier">${escapeHtml(item.identifier)}</span>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" ${item.enabled ? 'checked' : ''} data-identifier="${item.identifier}">
                    <span class="toggle-slider"></span>
                </label>
                ${actionBtn}
            `;

            // Toggle handler
            const toggle = el.querySelector('.toggle-switch input');
            toggle.addEventListener('change', (e) => {
                e.stopPropagation();
                item.enabled = toggle.checked;
                el.classList.toggle('disabled', !toggle.checked);
                renderJsonPreview(data);
            });

            // Edit / Info handler
            el.querySelector('.prompt-edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (isMarker) {
                    openMarkerInfo(item.identifier);
                } else {
                    openPromptEditor(item.identifier);
                }
            });

            // Drag handlers
            el.addEventListener('dragstart', (e) => {
                el.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', idx.toString());
            });
            el.addEventListener('dragend', () => el.classList.remove('dragging'));
            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                el.classList.add('drag-over');
            });
            el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = idx;
                if (fromIdx === toIdx) return;
                const [moved] = order.splice(fromIdx, 1);
                order.splice(toIdx, 0, moved);
                setPromptOrder(data, order);
                renderPromptOrder(data);
                renderJsonPreview(data);
                toast('Prompt order updated');
            });

            promptOrderList.appendChild(el);
        });
    }

    // ==================== MARKER INFO MODAL ====================
    function openMarkerInfo(identifier) {
        const data = getActivePreset();
        if (!data) return;
        const def = getPromptDef(data, identifier);
        const info = MARKER_DESCRIPTIONS[identifier];

        state.editingPromptId = null;
        state.isNewPrompt = false;

        modalTitle.textContent = `ℹ️ ${def?.name || identifier}`;
        modalPromptName.value = def?.name || identifier;
        modalPromptName.readOnly = true;
        modalPromptName.style.opacity = '0.6';
        modalPromptRole.value = 'system';
        modalPromptRole.disabled = true;
        modalPromptId.value = identifier;
        modalPromptId.readOnly = true;
        modalPromptId.style.opacity = '0.5';
        modalPromptContent.value = info
            ? `[ENGINE-INJECTED — NOT EDITABLE]\n\nSource: ${info.source}\n\n${info.desc}`
            : '[This marker\'s content is injected by the SillyTavern engine at runtime.]';
        modalPromptContent.readOnly = true;
        modalPromptContent.style.opacity = '0.6';
        modalPromptMarker.checked = true;
        modalPromptMarker.disabled = true;
        $('btnDeletePrompt').style.display = 'none';
        $('btnSavePrompt').style.display = 'none';

        showModal();
    }

    // ==================== PROMPT EDITOR MODAL ====================
    function openPromptEditor(identifier) {
        const data = getActivePreset();
        if (!data) return;
        const def = getPromptDef(data, identifier);

        state.editingPromptId = identifier;
        state.isNewPrompt = false;

        modalTitle.textContent = def ? `Edit: ${def.name}` : `Edit: ${identifier}`;
        modalPromptName.value = def?.name || identifier;
        modalPromptName.readOnly = false;
        modalPromptName.style.opacity = '1';
        modalPromptRole.value = def?.role || 'system';
        modalPromptRole.disabled = false;
        modalPromptId.value = identifier;
        modalPromptContent.value = def?.content || '';
        modalPromptContent.readOnly = false;
        modalPromptContent.style.opacity = '1';
        modalPromptMarker.checked = false;
        modalPromptMarker.disabled = false;
        $('btnSavePrompt').style.display = '';

        // Disable editing identifier for built-in system prompts
        const isBuiltIn = ['main', 'nsfw', 'jailbreak'].includes(identifier);
        modalPromptId.readOnly = isBuiltIn;
        modalPromptId.style.opacity = isBuiltIn ? '0.5' : '1';
        $('btnDeletePrompt').style.display = isBuiltIn ? 'none' : '';

        showModal();
    }

    function openNewPromptEditor() {
        const data = getActivePreset();
        if (!data) return;

        state.editingPromptId = null;
        state.isNewPrompt = true;

        modalTitle.textContent = 'Add Custom Prompt';
        modalPromptName.value = '';
        modalPromptRole.value = 'system';
        modalPromptId.value = '';
        modalPromptContent.value = '';
        modalPromptMarker.checked = false;
        modalPromptId.readOnly = false;
        modalPromptId.style.opacity = '1';
        $('btnDeletePrompt').style.display = 'none';

        showModal();
    }

    function showModal() {
        modalOverlay.classList.add('visible');
    }

    function hideModal() {
        modalOverlay.classList.remove('visible');
        // Reset all modal field states to editable defaults
        modalPromptName.readOnly = false;
        modalPromptName.style.opacity = '1';
        modalPromptRole.disabled = false;
        modalPromptContent.readOnly = false;
        modalPromptContent.style.opacity = '1';
        modalPromptMarker.disabled = false;
        $('btnSavePrompt').style.display = '';
    }

    // Modal event handlers
    $('btnCloseModal').addEventListener('click', hideModal);
    $('btnCancelModal').addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) hideModal();
    });

    $('btnAddPrompt').addEventListener('click', openNewPromptEditor);

    $('btnSavePrompt').addEventListener('click', () => {
        const data = getActivePreset();
        if (!data) return;

        const name = modalPromptName.value.trim();
        const identifier = modalPromptId.value.trim();
        const role = modalPromptRole.value;
        const content = modalPromptContent.value;
        const isMarker = modalPromptMarker.checked;

        if (!name || !identifier) {
            toast('Name and Identifier are required', 'error');
            return;
        }

        if (state.isNewPrompt) {
            // Check duplicate
            if (getPromptDef(data, identifier)) {
                toast('A prompt with this identifier already exists', 'error');
                return;
            }
            // Add to prompts array
            const newPrompt = { name, identifier, system_prompt: true, role, content };
            if (isMarker) newPrompt.marker = true;
            data.prompts.push(newPrompt);

            // Add to order
            const order = getPromptOrder(data);
            order.push({ identifier, enabled: true });
            setPromptOrder(data, order);

            toast(`Added "${name}"`);
        } else {
            // Update existing
            let def = getPromptDef(data, state.editingPromptId);
            if (def) {
                def.name = name;
                def.role = role;
                def.content = content;
                def.marker = isMarker;
                // If identifier changed
                if (state.editingPromptId !== identifier) {
                    const order = getPromptOrder(data);
                    const orderItem = order.find(o => o.identifier === state.editingPromptId);
                    if (orderItem) orderItem.identifier = identifier;
                    def.identifier = identifier;
                }
            } else {
                // Prompt def didn't exist (was only in order) — create it
                const newPrompt = { name, identifier, system_prompt: true, role, content };
                if (isMarker) newPrompt.marker = true;
                data.prompts.push(newPrompt);
            }
            toast(`Updated "${name}"`);
        }

        hideModal();
        renderAll();
    });

    $('btnDeletePrompt').addEventListener('click', () => {
        const data = getActivePreset();
        if (!data || !state.editingPromptId) return;

        // Remove from prompts
        data.prompts = data.prompts.filter(p => p.identifier !== state.editingPromptId);

        // Remove from order
        const order = getPromptOrder(data).filter(o => o.identifier !== state.editingPromptId);
        setPromptOrder(data, order);

        hideModal();
        renderAll();
        toast('Prompt deleted');
    });

    // ==================== RENDER SETTINGS ====================
    // Advanced parameter configs
    const MIROSTAT_PARAMS = [
        { key: 'mirostat_mode', label: 'Mirostat Mode', type: 'select', options: [{ v: 0, l: '0 — Tắt' }, { v: 1, l: '1 — Mirostat' }, { v: 2, l: '2 — Mirostat 2.0' }], default: 0 },
        { key: 'mirostat_tau', label: 'Mirostat Tau', min: 0, max: 10, step: 0.01, default: 5 },
        { key: 'mirostat_eta', label: 'Mirostat Eta', min: 0, max: 1, step: 0.01, default: 0.1 },
    ];

    const DRY_PARAMS = [
        { key: 'dry_multiplier', label: 'DRY Multiplier', min: 0, max: 5, step: 0.01, default: 0 },
        { key: 'dry_base', label: 'DRY Base', min: 1, max: 4, step: 0.01, default: 1.75 },
        { key: 'dry_allowed_length', label: 'DRY Allowed Length', min: 1, max: 20, step: 1, default: 2 },
    ];

    const DYNTEMP_PARAMS = [
        { key: 'dynatemp_low', label: 'Dynatemp Low', min: 0, max: 2, step: 0.01, default: 0 },
        { key: 'dynatemp_high', label: 'Dynatemp High', min: 0, max: 2, step: 0.01, default: 0 },
        { key: 'dynatemp_exponent', label: 'Dynatemp Exponent', min: 0.01, max: 5, step: 0.01, default: 1 },
    ];

    const CFG_PARAMS = [
        { key: 'guidance_scale', label: 'Guidance Scale (CFG)', min: 1, max: 30, step: 0.5, default: 1 },
    ];

    const CUTOFF_PARAMS = [
        { key: 'epsilon_cutoff', label: 'Epsilon Cutoff', min: 0, max: 9, step: 0.01, default: 0 },
        { key: 'eta_cutoff', label: 'Eta Cutoff', min: 0, max: 20, step: 0.01, default: 0 },
    ];

    const MISC_PARAMS = [
        { key: 'openai_max_context', label: 'Max Context (tokens)', min: 512, max: 200000, step: 1, default: 4095 },
        { key: 'openai_max_tokens', label: 'Max Response (tokens)', min: 16, max: 50000, step: 1, default: 300 },
        { key: 'seed', label: 'Seed (-1 = random)', min: -1, max: 999999, step: 1, default: -1 },
        { key: 'n', label: 'N (completions)', min: 1, max: 10, step: 1, default: 1 },
    ];

    const BOOL_FLAGS = [
        { key: 'stream_openai', label: 'Stream Response' },
        { key: 'max_context_unlocked', label: 'Unlock Max Context' },
        { key: 'use_sysprompt', label: 'Use System Prompt' },
        { key: 'squash_system_messages', label: 'Squash System Messages' },
        { key: 'media_inlining', label: 'Media Inlining' },
        { key: 'bypass_status_check', label: 'Bypass Status Check' },
        { key: 'continue_prefill', label: 'Continue Prefill' },
    ];

    const SAMPLER_NAMES = {
        0: 'Top-K', 1: 'Top-A', 2: 'Top-P', 3: 'TFS',
        4: 'Epsilon Cutoff', 5: 'Eta Cutoff', 6: 'Rep Penalty',
        7: 'Temperature', 8: 'Min-P',
    };

    function renderSettings(data) {
        // Core Sampling
        const coreSamplingGrid = $('coreSamplingGrid');
        coreSamplingGrid.innerHTML = '';
        SAMPLING_PARAMS.forEach(p => coreSamplingGrid.appendChild(createSliderCard(data, p)));

        // Context
        const contextGrid = $('contextGrid');
        contextGrid.innerHTML = '';
        [
            { key: 'openai_max_context', label: 'Max Context (tokens)', min: 512, max: 200000, step: 1, default: 4095 },
            { key: 'openai_max_tokens', label: 'Max Response (tokens)', min: 16, max: 50000, step: 1, default: 300 },
        ].forEach(p => contextGrid.appendChild(createSliderCard(data, p)));

        // Advanced - Mirostat
        const mirostatRow = $('mirostatRow');
        mirostatRow.innerHTML = '';
        MIROSTAT_PARAMS.forEach(p => {
            if (p.type === 'select') {
                mirostatRow.appendChild(createSelectCard(data, p));
            } else {
                mirostatRow.appendChild(createSliderCard(data, p));
            }
        });

        // Advanced - DRY
        const dryRow = $('dryRow');
        dryRow.innerHTML = '';
        DRY_PARAMS.forEach(p => dryRow.appendChild(createSliderCard(data, p)));
        const drySeqBreakers = $('drySeqBreakers');
        drySeqBreakers.innerHTML = '';
        drySeqBreakers.appendChild(createTextCard(data, 'dry_sequence_breakers', 'DRY Sequence Breakers', '["\\n", ":", "\\"", "*"]'));

        // Advanced - Dynamic Temp
        const dynTempRow = $('dynTempRow');
        dynTempRow.innerHTML = '';
        DYNTEMP_PARAMS.forEach(p => dynTempRow.appendChild(createSliderCard(data, p)));

        // Advanced - CFG
        const cfgRow = $('cfgRow');
        cfgRow.innerHTML = '';
        CFG_PARAMS.forEach(p => cfgRow.appendChild(createSliderCard(data, p)));
        const cfgNegPrompt = $('cfgNegPrompt');
        cfgNegPrompt.innerHTML = '';
        cfgNegPrompt.appendChild(createTextareaCard(data, 'negative_prompt', 'Negative Prompt', 'Prompt tiêu cực cho CFG...'));

        // Advanced - Cutoffs
        const cutoffRow = $('cutoffRow');
        cutoffRow.innerHTML = '';
        CUTOFF_PARAMS.forEach(p => cutoffRow.appendChild(createSliderCard(data, p)));

        // Advanced - Sampler Order
        renderSamplerOrder(data);

        // Other - Misc
        const miscSettingsGrid = $('miscSettingsGrid');
        miscSettingsGrid.innerHTML = '';
        MISC_PARAMS.forEach(p => miscSettingsGrid.appendChild(createSliderCard(data, p)));

        // Other - Bool flags
        const boolFlagsGrid = $('boolFlagsGrid');
        boolFlagsGrid.innerHTML = '';
        BOOL_FLAGS.forEach(flag => {
            const item = document.createElement('div');
            item.className = 'bool-flag-item';
            item.innerHTML = `
                <label class="toggle-switch">
                    <input type="checkbox" ${data[flag.key] ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
                <span class="flag-label">${flag.label}</span>
            `;
            const tog = item.querySelector('input');
            tog.addEventListener('change', () => {
                data[flag.key] = tog.checked;
                renderJsonPreview(data);
            });
            boolFlagsGrid.appendChild(item);
        });
    }

    function createSliderCard(data, param) {
        const val = data[param.key] ?? param.default;
        const card = document.createElement('div');
        card.className = 'setting-card';
        card.innerHTML = `
            <div class="setting-card-header">
                <label><span class="param-dot"></span>${param.label}</label>
                <span class="setting-value">${val}</span>
            </div>
            <input type="range" class="setting-slider"
                   min="${param.min}" max="${param.max}" step="${param.step}" value="${val}">
        `;
        const slider = card.querySelector('.setting-slider');
        const valueEl = card.querySelector('.setting-value');
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            valueEl.textContent = v;
            data[param.key] = v;
            renderJsonPreview(data);
        });
        return card;
    }

    function createSelectCard(data, param) {
        const val = data[param.key] ?? param.default;
        const card = document.createElement('div');
        card.className = 'setting-select-card';
        const optionsHtml = param.options.map(o => `<option value="${o.v}" ${val == o.v ? 'selected' : ''}>${o.l}</option>`).join('');
        card.innerHTML = `
            <label>${param.label}</label>
            <select>${optionsHtml}</select>
        `;
        const sel = card.querySelector('select');
        sel.addEventListener('change', () => {
            data[param.key] = parseInt(sel.value);
            renderJsonPreview(data);
        });
        return card;
    }

    function createTextCard(data, key, label, placeholder) {
        const val = data[key] ?? '';
        const card = document.createElement('div');
        card.className = 'setting-text-card';
        card.innerHTML = `<label>${label}</label><input type="text" value="${escapeHtml(typeof val === 'string' ? val : JSON.stringify(val))}" placeholder="${placeholder}">`;
        const input = card.querySelector('input');
        input.addEventListener('change', () => {
            try { data[key] = JSON.parse(input.value); } catch { data[key] = input.value; }
            renderJsonPreview(data);
        });
        return card;
    }

    function createTextareaCard(data, key, label, placeholder) {
        const val = data[key] ?? '';
        const card = document.createElement('div');
        card.className = 'setting-text-card';
        card.innerHTML = `<label>${label}</label><textarea placeholder="${placeholder}">${escapeHtml(val)}</textarea>`;
        const ta = card.querySelector('textarea');
        ta.addEventListener('input', () => {
            data[key] = ta.value;
            renderJsonPreview(data);
        });
        return card;
    }

    // ==================== SAMPLER ORDER ====================
    function renderSamplerOrder(data) {
        const list = $('samplerOrderList');
        list.innerHTML = '';
        if (!data.sampler_order) {
            data.sampler_order = [6, 0, 1, 3, 4, 5, 2, 7, 8]; // default order
        }
        const order = data.sampler_order;

        order.forEach((id, idx) => {
            const name = SAMPLER_NAMES[id] || `Sampler ${id}`;
            const el = document.createElement('div');
            el.className = 'sampler-order-item';
            el.draggable = true;
            el.dataset.index = idx;
            el.innerHTML = `
                <div class="order-handle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </div>
                <span class="order-index">${idx + 1}</span>
                <span class="order-name">${name}</span>
                <span class="order-id">${id}</span>
            `;

            el.addEventListener('dragstart', (e) => {
                el.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', idx.toString());
            });
            el.addEventListener('dragend', () => el.classList.remove('dragging'));
            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                el.classList.add('drag-over');
            });
            el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = idx;
                if (fromIdx === toIdx) return;
                const [moved] = order.splice(fromIdx, 1);
                order.splice(toIdx, 0, moved);
                renderSamplerOrder(data);
                renderJsonPreview(data);
                toast('Sampler order updated');
            });

            list.appendChild(el);
        });
    }

    // ==================== RENDER MODEL BADGES ====================
    function renderModelBadges(data) {
        modelBadges.innerHTML = '';
        MODEL_KEYS.forEach(({ key, label }) => {
            const val = data[key];
            if (!val) return;
            const badge = document.createElement('div');
            badge.className = 'model-badge';
            badge.innerHTML = `<span class="badge-label">${label}</span> ${escapeHtml(val)}`;
            modelBadges.appendChild(badge);
        });

        // Source badge
        if (data.chat_completion_source) {
            const badge = document.createElement('div');
            badge.className = 'model-badge';
            badge.style.borderColor = 'rgba(124, 92, 252, 0.3)';
            badge.innerHTML = `<span class="badge-label">Source</span> ${escapeHtml(data.chat_completion_source)}`;
            modelBadges.prepend(badge);
        }
    }

    // ==================== RENDER SPECIAL PROMPTS ====================
    function renderSpecialPrompts(data) {
        specialPromptsGrid.innerHTML = '';
        SPECIAL_PROMPT_KEYS.forEach(({ key, label }) => {
            const val = data[key] ?? '';
            const card = document.createElement('div');
            card.className = 'special-prompt-card';
            card.innerHTML = `
                <label>${label}</label>
                <textarea>${escapeHtml(val)}</textarea>
            `;
            const ta = card.querySelector('textarea');
            ta.addEventListener('input', () => {
                data[key] = ta.value;
                renderJsonPreview(data);
            });
            specialPromptsGrid.appendChild(card);
        });
    }

    // ==================== RENDER JSON PREVIEW ====================
    function renderJsonPreview(data) {
        const json = JSON.stringify(data, null, 2);
        jsonPreviewContent.innerHTML = syntaxHighlightJSON(escapeHtml(json));
        // Auto-save to server (debounced)
        scheduleAutoSave();
    }

    // ==================== AUTO-SAVE ====================
    function scheduleAutoSave() {
        if (state.saveTimer) clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(() => autoSave(), 1500);
    }

    async function autoSave() {
        const preset = state.presets[state.activeIndex];
        if (!preset || !preset.id) return;
        try {
            await fetch(`/api/presets/${preset.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: preset.name, data: preset.data }),
            });
        } catch (err) {
            console.error('Auto-save failed:', err);
        }
    }

    // ==================== COPY JSON ====================
    $('btnCopyJson').addEventListener('click', () => {
        const data = getActivePreset();
        if (!data) return;
        const json = JSON.stringify(data, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            toast('JSON copied to clipboard');
        }).catch(() => {
            toast('Failed to copy', 'error');
        });
    });

    // ==================== TABS ====================
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            $('tab-' + tab).classList.add('active');

            // Refresh JSON when switching to JSON tab
            if (tab === 'json') {
                const data = getActivePreset();
                if (data) renderJsonPreview(data);
            }
        });
    });

    // ==================== SUB-TABS ====================
    document.querySelectorAll('.sub-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const subtab = btn.dataset.subtab;
            $('subtab-' + subtab).classList.add('active');
        });
    });

    // ==================== MOBILE SIDEBAR TOGGLE ====================
    const sidebar = document.querySelector('.sidebar');
    const sidebarOverlay = $('sidebarOverlay');
    const sidebarToggle = $('sidebarToggle');

    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('visible');
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('visible');
    }

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
        });
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', closeSidebar);
    }

    // Auto-close sidebar on mobile when preset selected
    const origSelectPreset = selectPreset;
    selectPreset = function(index) {
        origSelectPreset(index);
        if (window.innerWidth <= 680) closeSidebar();
    };

    // ==================== INIT ====================
    async function init() {
        showEmptyState();
        // Load presets from server
        try {
            const res = await fetch('/api/presets');
            if (res.ok) {
                const serverPresets = await res.json();
                if (serverPresets.length > 0) {
                    state.presets = serverPresets.map(p => ({
                        id: p.id,
                        name: p.name,
                        data: p.data,
                        fileName: p.fileName,
                    }));
                    renderPresetList();
                    selectPreset(0);
                    toast(`Loaded ${serverPresets.length} preset(s) from server`);
                }
            }
        } catch (err) {
            console.log('No server presets or running locally:', err.message);
        }
    }
    init();
})();

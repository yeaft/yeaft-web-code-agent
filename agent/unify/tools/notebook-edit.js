/**
 * notebook-edit.js — Edit Jupyter notebook cells.
 *
 * Reads and modifies .ipynb notebook files by cell index.
 */

import { defineTool } from './types.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

export default defineTool({
  name: 'NotebookEdit',
  description: `Edit a Jupyter notebook (.ipynb file) cell.

Actions:
- "replace" — replace the source of a cell at the given index
- "insert" — insert a new cell after the given index
- "delete" — delete the cell at the given index
- "read" — read the notebook content (all cells)

Cell types: "code" or "markdown"`,
  parameters: {
    type: 'object',
    properties: {
      notebook_path: {
        type: 'string',
        description: 'Path to the .ipynb file',
      },
      action: {
        type: 'string',
        enum: ['replace', 'insert', 'delete', 'read'],
        description: 'Operation to perform (default: "replace")',
      },
      cell_index: {
        type: 'number',
        description: 'Cell index (0-based)',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description: 'Cell type for insert/replace',
      },
      source: {
        type: 'string',
        description: 'New cell source content',
      },
    },
    required: ['notebook_path'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'read',
  async execute(input, ctx) {
    const { notebook_path, action = 'replace', cell_index, cell_type, source } = input;
    if (!notebook_path) return JSON.stringify({ error: 'notebook_path is required' });

    const cwd = ctx?.cwd || process.cwd();
    const absPath = resolve(cwd, notebook_path);

    if (!existsSync(absPath)) {
      if (action === 'read') return JSON.stringify({ error: `Notebook not found: ${absPath}` });
      // For write actions on new file, create an empty notebook
    }

    try {
      let notebook;
      if (existsSync(absPath)) {
        const raw = await readFile(absPath, 'utf-8');
        notebook = JSON.parse(raw);
      } else {
        notebook = {
          cells: [],
          metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
          nbformat: 4,
          nbformat_minor: 5,
        };
      }

      if (action === 'read') {
        return JSON.stringify({
          cells: notebook.cells.map((cell, i) => ({
            index: i,
            cell_type: cell.cell_type,
            source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
            outputs: cell.outputs ? cell.outputs.length : 0,
          })),
          totalCells: notebook.cells.length,
        }, null, 2);
      }

      if (action === 'replace') {
        if (cell_index === undefined) return JSON.stringify({ error: 'cell_index is required for replace' });
        if (source === undefined) return JSON.stringify({ error: 'source is required for replace' });
        if (cell_index < 0 || cell_index >= notebook.cells.length) {
          return JSON.stringify({ error: `Cell index ${cell_index} out of range (0-${notebook.cells.length - 1})` });
        }

        notebook.cells[cell_index].source = source.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l);
        if (cell_type) notebook.cells[cell_index].cell_type = cell_type;
      } else if (action === 'insert') {
        if (source === undefined) return JSON.stringify({ error: 'source is required for insert' });
        const type = cell_type || 'code';
        const newCell = {
          cell_type: type,
          source: source.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l),
          metadata: {},
          ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
        };
        const insertIdx = cell_index !== undefined ? cell_index + 1 : notebook.cells.length;
        notebook.cells.splice(insertIdx, 0, newCell);
      } else if (action === 'delete') {
        if (cell_index === undefined) return JSON.stringify({ error: 'cell_index is required for delete' });
        if (cell_index < 0 || cell_index >= notebook.cells.length) {
          return JSON.stringify({ error: `Cell index ${cell_index} out of range` });
        }
        notebook.cells.splice(cell_index, 1);
      }

      await writeFile(absPath, JSON.stringify(notebook, null, 1), 'utf-8');

      return JSON.stringify({
        success: true,
        action,
        totalCells: notebook.cells.length,
        message: `Notebook ${action}d successfully`,
      });
    } catch (err) {
      return JSON.stringify({ error: `Notebook edit failed: ${err.message}` });
    }
  },
});

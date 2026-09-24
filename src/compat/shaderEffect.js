/**
 * Pure base class providing modern GNOME 51 ShaderEffect interface.
 *
 * In GNOME 51+, Shell.GLSLEffect was removed in favor of Clutter.ShaderEffect.
 * This module transparently adapts Clutter.ShaderEffect (GNOME 51+) and
 * Shell.GLSLEffect (GNOME 45–50) with zero global prototype mutation.
 *
 * Subclasses provide shader code via `static getSnippet()` returning a Cogl.Snippet,
 * and upload uniforms via `this.set_uniform_float(name, n_components, total_count, value)`.
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

// Shell.GLSLEffect was dropped in GNOME 51 (gi://Shell namespace import remains valid,
// but Shell.GLSLEffect evaluates to undefined). When undefined, we take the modern
// Clutter.ShaderEffect branch.
export const ShaderEffect = Shell?.GLSLEffect
    ? GObject.registerClass({
        GTypeName: 'WindowNativizerShaderEffectCompat',
    }, class ShaderEffectLegacy extends Shell.GLSLEffect {
        _init(params) {
            super._init(params);
            this._uniformLocMap = new Map();
        }

        vfunc_build_pipeline() {
            const source = this.constructor.getShaderSource?.();
            if (source) {
                this.add_glsl_snippet(
                    source.hook ?? Cogl.SnippetHook.FRAGMENT,
                    source.declarations ?? '',
                    source.code ?? '',
                    Boolean(source.replace)
                );
                return;
            }
            const snippet = this.constructor.getSnippet?.();
            if (snippet) {
                const replace = snippet.get_replace?.();
                const post = snippet.get_post?.();
                this.add_glsl_snippet(
                    snippet.get_hook?.() ?? Cogl.SnippetHook.FRAGMENT,
                    snippet.get_declarations?.() ?? '',
                    replace || post || '',
                    Boolean(replace)
                );
            }
        }

        /**
         * Sets float uniform using variable name, caching location on GNOME 45–50.
         * Targets modern GNOME 51 3-argument signature: (name, n_components, value).
         * @param {string} name
         * @param {number} n_components
         * @param {number[]} value
         */
        set_uniform_float(name, n_components, value) {
            let loc = this._uniformLocMap.get(name);
            if (loc === undefined) {
                loc = this.get_uniform_location(name);
                this._uniformLocMap.set(name, loc);
            }
            if (loc !== -1)
                super.set_uniform_float(loc, n_components, value);
        }
    })
    : GObject.registerClass({
        GTypeName: 'WindowNativizerShaderEffectCompat',
    }, class ShaderEffectModern extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            const snippet = this.constructor.getSnippet?.();
            if (snippet)
                return snippet;
            const source = this.constructor.getShaderSource?.();
            if (source) {
                const hook = source.hook ?? Cogl.SnippetHook.FRAGMENT;
                const declarations = source.declarations ?? '';
                const post = source.replace ? null : source.code ?? '';
                const s = Cogl.Snippet.new
                    ? Cogl.Snippet.new(hook, declarations, post)
                    : new Cogl.Snippet(hook, declarations, post);
                if (source.replace)
                    s.set_replace(source.code ?? '');
                return s;
            }
            return null;
        }
    });

/* eslint-disable complexity -- Role interaction flow is permission-sensitive; refactor separately. */
/*
 * Role Button Feature
 * สร้าง role button panels ที่ซับซ้อนกว่า verification
 * สำหรับอนาคต: multi-role panels, role menus
 */
const { PermissionFlagsBits } = require("discord.js");
const { MessageEmbed, MessageActionRow, MessageButton, MessageSelectMenu } = require('../core/discordCompat');
const config = require('../config.json');

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS            = 5;
const MAX_ROLES           = MAX_BUTTONS_PER_ROW * MAX_ROWS; // 25

function getBotMember(guild) {
    return guild?.members?.me || guild?.me || guild?.members?.cache?.get(guild?.client?.user?.id);
}

function validateRoleChange(guild, member, role) {
    if (!guild) return { ok: false, reason: 'ไม่พบเซิร์ฟเวอร์' };
    if (!member?.roles?.cache) return { ok: false, reason: 'ไม่พบสมาชิก' };
    if (!role) return { ok: false, reason: 'ไม่พบยศนี้' };

    const botMember = getBotMember(guild);
    if (!botMember) return { ok: false, reason: 'ไม่พบข้อมูลบอทในเซิร์ฟเวอร์' };
    if (!botMember.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return { ok: false, reason: 'บอทไม่มีสิทธิ์ Manage Roles' };
    if (role.managed) return { ok: false, reason: 'ยศนี้เป็น managed role' };
    if (botMember.roles?.highest && role.position >= botMember.roles.highest.position) {
        return { ok: false, reason: 'ยศสูงกว่าหรือเท่ากับยศสูงสุดของบอท' };
    }

    return { ok: true };
}

/**
 * สร้าง role button panel (หลายยศในข้อความเดียว)
 * @param {Object} options
 * @param {Array}  options.roles   - [{roleId, label, emoji, style}]
 * @param {Object} options.embed   - embed options
 * @param {string} options.type    - 'button' | 'select'
 */
function buildRolePanel(options = {}) {
    const {
        roles  = [],
        embed  = {},
        type   = 'button'
    } = options;

    if (!roles.length) throw new Error('ต้องมีอย่างน้อย 1 ยศ');
    if (roles.length > MAX_ROLES) throw new Error(`ไม่เกิน ${MAX_ROLES} ยศ`);

    const embedObj = new MessageEmbed()
        .setColor(embed.color || config.system.themeColors.primary)
        .setTitle(embed.title || 'เลือกยศของคุณ');
    if (embed.description) embedObj.setDescription(embed.description);
    if (embed.footer)      embedObj.setFooter({ text: embed.footer });
    if (embed.image)       embedObj.setImage(embed.image);
    if (embed.thumbnail)   embedObj.setThumbnail(embed.thumbnail);

    let components = [];

    if (type === 'select') {
        // Dropdown menu
        const menu = new MessageSelectMenu()
            .setCustomId('roleselect_menu')
            .setPlaceholder('เลือกยศที่ต้องการ...')
            .setMinValues(0)
            .setMaxValues(Math.min(roles.length, 25))
            .addOptions(roles.slice(0, 25).map(r => ({
                label:       r.label || `ยศ ${r.roleId}`,
                value:       `role_${r.roleId}`,
                emoji:       r.emoji  || '🎭',
                ...(r.desc ? { description: String(r.desc).slice(0, 100) } : {})
            })));
        components = [new MessageActionRow().addComponents(menu)];
    } else {
        // Buttons (max 5 per row, max 5 rows)
        const rows = [];
        for (let i = 0; i < roles.length; i += MAX_BUTTONS_PER_ROW) {
            const chunk = roles.slice(i, i + MAX_BUTTONS_PER_ROW);
            const row = new MessageActionRow().addComponents(
                chunk.map(r => new MessageButton()
                    .setCustomId(`rolebtn_${r.roleId}`)
                    .setLabel(r.label || `ยศ`)
                    .setEmoji(r.emoji || '🎭')
                    .setStyle(r.style || 'SECONDARY')
                )
            );
            rows.push(row);
        }
        components = rows;
    }

    return { embeds: [embedObj], components };
}

/**
 * Handle role button / select interaction
 */
async function applySingleRoleChange(member, role, shouldAdd, results) {
    const has = member.roles.cache.has(role.id);
    if (shouldAdd && !has) {
        try {
            await member.roles.add(role.id);
            results.added.push(role.name);
        } catch (err) {
            results.failed.push(`${role.name}: ${err.message}`);
        }
    } else if (!shouldAdd && has) {
        try {
            await member.roles.remove(role.id);
            results.removed.push(role.name);
        } catch (err) {
            results.failed.push(`${role.name}: ${err.message}`);
        }
    }
}

async function processRoleSelection(guild, member, rid, selectedRoleIds, results) {
    const role = guild.roles.cache.get(rid);
    const check = validateRoleChange(guild, member, role);
    if (!check.ok) {
        results.skipped.push(`${role?.name || rid}: ${check.reason}`);
        return;
    }
    await applySingleRoleChange(member, role, selectedRoleIds.includes(rid), results);
}

function formatRoleSelectionSummary(results) {
    const lines = [];
    if (results.added.length)   lines.push(`✅ เพิ่ม: ${results.added.join(', ')}`);
    if (results.removed.length) lines.push(`❌ ลบ: ${results.removed.join(', ')}`);
    if (results.skipped.length) lines.push(`⚠️ ข้าม: ${results.skipped.slice(0, 6).join(' | ')}`);
    if (results.failed.length)  lines.push(`🚫 ไม่สำเร็จ: ${results.failed.slice(0, 6).join(' | ')}`);
    if (!lines.length)          lines.push('ไม่มีการเปลี่ยนแปลง');
    return lines.join('\n');
}

async function handleRoleSelectMenu(interaction, member, guild) {
    const selectedRoleIds = interaction.values.map(v => v.replace('role_', ''));
    const allPanelRoleIds = interaction.component.options.map(o => o.value.replace('role_', ''));

    await interaction.deferReply({ ephemeral: true });

    const results = {
        added: [],
        removed: [],
        skipped: [],
        failed: []
    };

    for (const rid of allPanelRoleIds) {
        await processRoleSelection(guild, member, rid, selectedRoleIds, results);
    }

    return interaction.editReply({ content: formatRoleSelectionSummary(results) });
}

/**
 * Handle role button / select interaction
 */
async function handleRoleInteraction(interaction) {
    const { member, guild, customId } = interaction;

    // Button: rolebtn_{roleId}
    if (interaction.isButton() && customId.startsWith('rolebtn_')) {
        const roleId = customId.replace('rolebtn_', '');
        return toggleRole(interaction, member, guild, roleId);
    }

    // Select menu: roleselect_menu
    if (interaction.isStringSelectMenu() && customId === 'roleselect_menu') {
        return handleRoleSelectMenu(interaction, member, guild);
    }
}

async function toggleRole(interaction, member, guild, roleId) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
        return interaction.reply({ content: `> ❌ ไม่พบยศนี้`, ephemeral: true });
    }
    const check = validateRoleChange(guild, member, role);
    if (!check.ok) {
        return interaction.reply({ content: `> ❌ จัดการยศไม่ได้: ${check.reason}`, ephemeral: true });
    }

    try {
        const hasRole = member.roles.cache.has(roleId);
        if (hasRole) {
            await member.roles.remove(roleId);
            const embed = new MessageEmbed()
                .setColor(config.system.themeColors.error)
                .setTitle('Removed Roles')
                .setDescription(`- ${role.toString()} (user)`)
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            await member.roles.add(roleId);
            const embed = new MessageEmbed()
                .setColor(config.system.themeColors.success)
                .setTitle('Added Roles')
                .setDescription(`+ ${role.toString()} (user)`)
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    } catch (err) {
        return interaction.reply({ content: `> ❌ จัดการยศไม่ได้: ${err.message}`, ephemeral: true });
    }
}

module.exports = {
    buildRolePanel,
    handleRoleInteraction,
    toggleRole,
    validateRoleChange,
    _test: {
        applySingleRoleChange,
        processRoleSelection,
        formatRoleSelectionSummary,
        handleRoleSelectMenu
    }
};

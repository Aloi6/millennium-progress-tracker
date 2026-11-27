local millennium = require('millennium')
local fs = require('fs')

local function write_export(contents, extension)
  if type(contents) ~= 'string' or #contents > 16777216 then
    error('Invalid or oversized export')
  end

  local base = os.getenv('LOCALAPPDATA')
  if not base or base == '' then base = os.getenv('XDG_DATA_HOME') end
  if not base or base == '' then
    local home = os.getenv('HOME')
    if not home or home == '' then error('No user data directory is available') end
    base = home .. '/.local/share'
  end

  local directory = base .. '/Millennium Progress Tracker/Exports'
  local created, create_error = fs.create_directories(directory)
  if created == nil then error(create_error or 'Could not create export folder') end

  local stem = directory .. '/steam-progress-' .. os.date('!%Y-%m-%d-%H%M%S')
  local path = stem .. extension
  local suffix = 2
  while fs.exists(path) do
    path = stem .. '-' .. suffix .. extension
    suffix = suffix + 1
  end

  local temporary = path .. '.tmp'
  local file, open_error = io.open(temporary, 'wb')
  if not file then error(open_error or 'Could not open export file') end
  local wrote, write_error = file:write(contents)
  local closed, close_error = file:close()
  if not wrote or not closed then
    fs.remove(temporary)
    error(write_error or close_error or 'Could not write export file')
  end

  local renamed, rename_error = fs.rename(temporary, path)
  if not renamed then
    fs.remove(temporary)
    error(rename_error or 'Could not finish the export')
  end
  return { directory = directory, path = path }
end

---@ffi
---@param csv string
---@return table
function export_csv(csv)
  return write_export(csv, '.csv')
end

---@ffi
---@param json string
---@return table
function export_backup(json)
  return write_export(json, '.json')
end

return {
  on_load = function() millennium.ready() end,
  export_csv = export_csv,
  export_backup = export_backup,
  patches = {
    {
      file = [[sp\.js]],
      find = [[return\(0,\w+\.jsxs\)\(\w+\.tz,\{label:\w+\.length==1\?\w+\[0\]\.display_name:null,children:\[!this\.props\.omitPrimaryAction&&this\.GetPrimaryActionMenuItem\(\w+,\w+\),this\.props\.additionalActions,]],
      transforms = {
        {
          match = [[(return\(0,\w+\.jsxs\)\((\w+)\.tz,\{label:(\w+)\.length==1\?\w+\[0\]\.display_name:null,children:\[!this\.props\.omitPrimaryAction&&this\.GetPrimaryActionMenuItem\(\w+,\w+\),this\.props\.additionalActions,)]],
          replace = [[\1\3.length===1&&!this.props.bInGamepadUI&&#{{self}}?.nativeMenu?.render?.(\3[0],\2.Vs,\2.kt,\2.K5),]],
        },
      },
    },
  },
}
